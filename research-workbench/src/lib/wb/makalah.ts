// Makalah generation pipeline — deterministic, human-supervised.
// The LLM never owns control flow: every LLM call is a pure function
// (fixed input -> fixed JSON output, no tools, no memory of other calls).
// Application code owns: retrieval, validation, loops, rendering.
// Pipeline: outline (Mode A, 1 call) -> human approve -> per-section loop
// (retrieve in code -> section call -> validate in code) -> PDF (print view).

import { createClient } from "@/lib/supabase/client";
import { retrieveContext } from "@/lib/rag/retrieve";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { AIProvider } from "@/lib/ai/types";
import type { InferenceSelection, StageSelection } from "./ask";
import { getWorkspaceId, type HydratedDoc } from "./library";
import { docToCslItem, renderCitationPlain } from "@/lib/citations";
import { titleFuzzyScore } from "@/lib/ingestion/dedup";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface OutlineSubsection {
  number: string;
  title: string;
  /** Mode A proposes `likely_sources`; after approval this becomes `source_ids`. */
  likely_sources?: string[];
  source_ids?: string[];
  /** One-sentence scope: the single question this subsection answers. */
  focus?: string;
  /** Topics this subsection must stay out of (owned by other subsections). */
  must_not_cover?: string[];
}

export interface OutlineChapter {
  chapter_number: string;
  chapter_title: string;
  subsections: OutlineSubsection[];
}

export interface MakalahOutline {
  outline: OutlineChapter[];
  coverage_notes: string;
}

export interface TemplateConstraints {
  required_top_level_sections: string[];
  min_subsections_per_chapter: number;
  max_subsections_per_chapter: number;
}

export interface SourceSummary {
  id: string;
  title: string;
  abstract_or_excerpt: string;
}

export interface SectionPassage {
  source_id: string;
  page: number | null;
  paragraph: number | null;
  text: string;
  score?: number;
}

export interface SectionCitation {
  source_id: string;
  page: number | null;
}

export interface SectionParagraph {
  text: string;
  citations: SectionCitation[];
}

export interface SectionOutput {
  paragraphs: SectionParagraph[];
  gaps: string;
}

export interface MakalahReference {
  id: string;
  formatted_apa7: string;
  /** True when the text was hand-edited in the Makalah UI (never auto-overwritten). */
  manual?: boolean;
}

export interface QualityReport {
  structure_complete: boolean;
  citation_integrity_pct: number;
  /** Total citations counted (0 → integrity % is meaningless, UI shows —). */
  citation_total: number;
  unsupported_claims: Array<{ subsection: string; paragraph: number; reason: string }>;
  missing_references: string[];
  unused_sources: string[];
  /** Cited entries that exist but look broken (no author, double period…). */
  malformed_references: string[];
  /** Section pairs whose drafted texts overlap heavily (possible duplication). */
  redundant_pairs: Array<{ a: string; b: string; score: number }>;
  /** Paragraphs with zero citations (model-bridged under hybrid grounding). */
  ai_filled: number;
}

/** Cheap broken-entry heuristic: author-less leading "(year)" or ".." doubling. */
export function isMalformedReference(entry: string): boolean {
  const t = (entry ?? "").trim();
  return !t || t.startsWith("(") || t.includes("..");
}

/** Marker placed in `gaps` when a section fell back to raw unstructured text. */
export const SECTION_SALVAGE_MARKER = "[unstructured-fallback]";

/**
 * Grounding modes for section drafting (chosen in Makalah Setup).
 * - off: 100% strict — every factual claim must come from passages.
 * - 15/85 (default): ~85% grounded, ~15% model intelligence for transitions
 *   and narrative coherence.
 * - 30/70: ~70% grounded, ~30% model intelligence for deeper synthesis and
 *   theoretical framing.
 * Paragraphs with zero citations are counted as model-bridged (`ai_filled`)
 * in the quality report — expected under hybrid, a warning under off.
 */
export type MakalahHybrid = "off" | "15/85" | "30/70";

export const MAKALAH_HYBRID_DEFAULT: MakalahHybrid = "15/85";

// ---------------------------------------------------------------------------
// Shared system prompt (small deltas per call)
// ---------------------------------------------------------------------------

export const MAKALAH_SHARED_SYSTEM =
  "You are a single-purpose text-generation function inside a document pipeline. " +
  "You do not plan, do not call tools, do not ask the user questions, and do not " +
  "decide what happens next in the pipeline — the calling application controls " +
  "that. You receive one well-defined input and must return exactly one " +
  "well-defined output in the exact schema requested. If the input is " +
  "insufficient to complete the task fully, do the best you can with what is " +
  "given and flag gaps explicitly in the output fields provided for that " +
  "purpose — never invent facts, sources, or citations to fill a gap.\n\n" +
  "JSON hygiene (mandatory): inside JSON strings, escape line breaks as \\n and " +
  "double quotes as \\\". Never use trailing commas. Numbers and booleans are " +
  "unquoted.\n\n" +
  "Output ONLY the requested JSON. No preamble, no markdown fences, no commentary " +
  "outside the JSON structure.";

// ---------------------------------------------------------------------------
// Provider + JSON helpers
// ---------------------------------------------------------------------------

function pickProvider(sel: InferenceSelection): { provider: AIProvider; model: string } {
  if (sel.provider === "ollama") return { provider: new OllamaProvider(), model: sel.model };
  return { provider: new CloudProvider(sel.cloudProvider), model: sel.cloudModel };
}

/** Resolve one makalah pipeline stage. "inherit"/empty falls back to main chat selection. */
function pickMakalahStage(
  sel: InferenceSelection,
  stage: StageSelection | undefined,
): { provider: AIProvider; model: string; label: string } {
  const mainLabel =
    sel.provider === "ollama" ? `ollama:${sel.model}` : `${sel.cloudProvider}:${sel.cloudModel}`;
  if (!stage || stage.provider === "inherit") {
    const { provider, model } = pickProvider(sel);
    return { provider, model, label: mainLabel };
  }
  if (stage.provider === "ollama") {
    const model = stage.model.trim() || sel.model;
    return { provider: new OllamaProvider(), model, label: `ollama:${model}` };
  }
  const cp = stage.cloudProvider || sel.cloudProvider;
  const model = stage.cloudModel.trim() || sel.cloudModel;
  return { provider: new CloudProvider(cp), model, label: `${cp}:${model}` };
}

/** Labels for UI display (Settings + Makalah setup step). */
export function makalahStageLabels(sel: InferenceSelection): { outline: string; section: string } {
  return {
    outline: pickMakalahStage(sel, sel.makalahOutlineStage).label,
    section: pickMakalahStage(sel, sel.makalahSectionStage).label,
  };
}

/** Per-call output cap, clamped so a typo can't produce empty/truncated JSON. */
function makalahBudget(sel: InferenceSelection): number {
  const n = sel.makalahNumPredict ?? 3072;
  return Math.min(16384, Math.max(256, n));
}

/** Thinking-token budget for drafting, clamped so typos can't starve answers. */
export function makalahThinkBudget(sel: InferenceSelection): number {
  return Math.min(4096, Math.max(128, sel.makalahThinkingBudget ?? 1024));
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/** Remove trailing commas before } or ] — the most common LLM JSON defect. */
function repairJson(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripFences(text);
  const candidates: string[] = [cleaned];
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy && greedy[0] !== cleaned) candidates.push(greedy[0]);
  let firstErr = "";
  for (const c of candidates) {
    for (const variant of [c, repairJson(c)]) {
      try {
        return JSON.parse(variant) as Record<string, unknown>;
      } catch (e) {
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(
    `Model did not return valid JSON (${firstErr || "no object found"}). Raw start: ${cleaned.slice(0, 200)}`,
  );
}

/**
 * Bounded JSON retry: one normal attempt, then (only on parse failure) one
 * correction attempt that shows the model its own bad output. Still fully
 * app-controlled — fixed max 2 calls, no autonomy. The thrown error carries
 * the last raw output as `(err as { raw?: string }).raw` for salvage paths.
 */
async function chatJson<T>(
  provider: AIProvider,
  model: string,
  system: string,
  user: string,
  numCtx: number,
  numPredict: number,
  parse: (t: string) => T,
  label: string,
  think: boolean | "low" | "medium" | "high" | "max" = false,
  thinkingBudget?: number,
  signal?: AbortSignal,
): Promise<T> {
  let lastRaw = "";
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1 ? user : (
        `${user}\n\nIMPORTANT: Your previous response was not valid JSON (${lastErr}). ` +
        `Reply now with ONLY the corrected JSON object — no preamble, no fences, no commentary. ` +
        `Fix this response:\n${lastRaw.slice(0, 6000)}`
      );
    const r = await provider.chat(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      {
        model, temperature: 0, numCtx, numPredict, thinking: think !== false,
        ...(typeof think === "string" ? { thinkLevel: think } : {}),
        // A bare budget ENABLES thinking on Gemini — only send it together
        // with thinking on, never on cold calls.
        ...(think !== false && typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    lastRaw = (r.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Reasoning models can burn the whole token budget thinking and return an
    // empty answer (native `thinking` field or a think-only block). Retrying
    // won't help — fail fast with an actionable message instead.
    if (!lastRaw) {
      const thought = (r.thinking ?? "").trim();
      const err = new Error(
        thought ?
          `${label}: model returned only reasoning with no answer (token budget spent thinking). ` +
            `Use a non-reasoning model for this Makalah stage in Settings, or raise num_ctx / output length.`
        : `${label}: model returned empty output. The model may be overloaded or still loading — wait a moment and retry.`,
      ) as Error & { raw?: string };
      err.raw = "";
      throw err;
    }
    try {
      return parse(lastRaw);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  const err = new Error(`${label} failed after retry: ${lastErr}`) as Error & { raw?: string };
  err.raw = lastRaw;
  throw err;
}

// ---------------------------------------------------------------------------
// Mode A — Outline Generator
// ---------------------------------------------------------------------------

export function buildOutlineUserPrompt(input: {
  topic: string;
  language: string;
  academic_level: string;
  source_summaries: SourceSummary[];
  template_constraints: TemplateConstraints;
}): string {
  const sources = input.source_summaries
    .map((s) => `- ${s.id} — ${s.title} — ${s.abstract_or_excerpt}`)
    .join("\n");
  const constraints = [
    `- Required top-level sections: ${input.template_constraints.required_top_level_sections.join("; ")}`,
    `- Min subsections per chapter: ${input.template_constraints.min_subsections_per_chapter}`,
    `- Max subsections per chapter: ${input.template_constraints.max_subsections_per_chapter}`,
  ].join("\n");
  return (
    `Topic: ${input.topic}\n` +
    `Language: ${input.language}\n` +
    `Academic level: ${input.academic_level}\n\n` +
    `Available sources (id — title — short excerpt):\n${sources || "(no sources provided)"}\n\n` +
    `Task: Propose a chapter/subsection outline for an academic paper (makalah) on ` +
    `this topic, grounded only in themes actually present in the sources above. ` +
    `Follow these structural constraints exactly:\n${constraints}\n\n` +
    `Chapter roles (generic, apply to any topic): the first chapter (Pendahuluan) ` +
    `covers background, problem, and scope — NO in-depth theory. The middle ` +
    `chapter(s) (Pembahasan) carry theories, analyses, and applications. The ` +
    `last chapter (Penutup) holds conclusions and suggestions only — no new ` +
    `material. Subsections must be mutually exclusive within AND across ` +
    `chapters: if two subsections could share a paragraph, split them again. ` +
    `Give each subsection a one-sentence "focus" (the single question it ` +
    `answers) and "must_not_cover" (topics owned by other subsections).\n\n` +
    `For each subsection, list which source ids plausibly support it (you are not ` +
    `writing content yet, only proposing structure and mapping likely evidence). ` +
    `Copy each source id EXACTLY as shown above — never abbreviate, renumber, or ` +
    `invent ids like "paper_01".\n\n` +
    `Return JSON only, in this schema:\n` +
    `{"outline": [{"chapter_number": "BAB I", "chapter_title": "Pendahuluan", ` +
    `"subsections": [{"number": "1.1", "title": "Latar Belakang", ` +
    `"focus": "why this topic matters", "must_not_cover": ["detailed theory"], ` +
    `"likely_sources": ["paper_01", "paper_04"]}]}], ` +
    `"coverage_notes": "any themes in the sources not reflected in the outline, or gaps"}`
  );
}

export function parseOutlineJson(text: string): MakalahOutline {
  const obj = extractJsonObject(text);
  const rawChapters = Array.isArray(obj.outline) ? obj.outline : [];
  const outline: OutlineChapter[] = rawChapters.map((c) => {
    const ch = c as Record<string, unknown>;
    const rawSubs = Array.isArray(ch.subsections) ? ch.subsections : [];
    return {
      chapter_number: String(ch.chapter_number ?? ""),
      chapter_title: String(ch.chapter_title ?? ""),
      subsections: rawSubs.map((s) => {
        const sub = s as Record<string, unknown>;
        const likely = Array.isArray(sub.likely_sources)
          ? (sub.likely_sources as unknown[]).map(String)
          : undefined;
        const ids = Array.isArray(sub.source_ids)
          ? (sub.source_ids as unknown[]).map(String)
          : undefined;
        const noCover = Array.isArray(sub.must_not_cover)
          ? (sub.must_not_cover as unknown[]).map(String).filter(Boolean).slice(0, 8)
          : undefined;
        return {
          number: String(sub.number ?? ""),
          title: String(sub.title ?? ""),
          ...(likely ? { likely_sources: likely } : {}),
          ...(ids ? { source_ids: ids } : {}),
          ...(typeof sub.focus === "string" && sub.focus.trim()
            ? { focus: sub.focus.trim().slice(0, 300) }
            : {}),
          ...(noCover?.length ? { must_not_cover: noCover } : {}),
        };
      }),
    };
  });
  return {
    outline,
    coverage_notes:
      typeof obj.coverage_notes === "string" ? obj.coverage_notes : "",
  };
}

function assertOutlineUsable(o: MakalahOutline): MakalahOutline {
  if (!o.outline.length) {
    throw new Error(
      "Model returned an outline with no chapters. Retry, or switch Mode A to a model that follows JSON schemas better.",
    );
  }
  return o;
}

/** One-line label for overlap reports: "1.1 Latar Belakang". */
export function outlineSubLabel(chapter_number: string, sub: OutlineSubsection): string {
  return `${sub.number || "?"} ${(sub.title || "").trim()}`.trim() + ` (${chapter_number})`;
}

function outlineScopeText(sub: OutlineSubsection): string {
  return [sub.title, sub.focus ?? "", ...(sub.must_not_cover ?? [])].join(" ");
}

/**
 * Generic outline-overlap gate (advisory, not blocking): pairwise
 * bigram similarity over title+focus. Flags pairs like "Tinjauan Umum X"
 * vs "Analisis Komprehensif Perkembangan X" for the human to re-split
 * before drafting. No topic knowledge — pure string similarity.
 */
export function findOutlineOverlaps(
  outline: OutlineChapter[],
  threshold = 0.5,
): Array<{ a: string; b: string; score: number }> {
  const flat = outline.flatMap((ch) =>
    ch.subsections.map((sub) => ({ label: outlineSubLabel(ch.chapter_number, sub), text: outlineScopeText(sub) })),
  );
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const s = titleFuzzyScore(flat[i].text, flat[j].text);
      if (s >= threshold) out.push({ a: flat[i].label, b: flat[j].label, score: Math.round(s * 100) / 100 });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Concatenate a section's paragraphs into one comparison string. */
export function sectionFullText(output: SectionOutput | null | undefined): string {
  return (output?.paragraphs ?? []).map((p) => p.text).join("\n\n");
}

/** Paragraphs with zero citations — model-bridged under hybrid grounding. */
export function countAiFilled(output: SectionOutput | null | undefined): number {
  return (output?.paragraphs ?? []).filter((p) => !p.citations.length).length;
}

/**
 * Generic cross-section duplication detector. Scores whole texts AND the
 * best-matching paragraph pair (duplication usually manifests as one
 * re-explained paragraph, which whole-text averaging dilutes). Calibrated
 * on real output: near-paraphrase paragraphs score ~0.8–0.9, topically
 * distinct paragraphs ~0.6 or below. Advisory — the UI lists pairs above
 * threshold for Regenerate/Edit.
 */
export function findRedundantPairs(
  sections: Array<{ label: string; text: string }>,
  threshold = 0.7,
): Array<{ a: string; b: string; score: number }> {
  // Bounded: quality recomputes on every secs change (autosave keystrokes),
  // and chapters are unbounded — cap sections/paragraphs before the O(S²·P²)
  // fuzzy comparison so a big draft can't wedge the render loop.
  const usable = sections.filter((s) => s.text.trim().length > 40).slice(0, 24);
  const parasOf = (t: string): string[] =>
    t.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 40).slice(0, 10);
  const pairScore = (a: string, b: string): number => {
    let best = titleFuzzyScore(a, b);
    const pa = parasOf(a);
    const pb = parasOf(b);
    for (const x of pa) {
      for (const y of pb) {
        const s = titleFuzzyScore(x, y);
        if (s > best) best = s;
      }
    }
    return best;
  };
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const s = pairScore(usable[i].text, usable[j].text);
      if (s >= threshold) out.push({ a: usable[i].label, b: usable[j].label, score: Math.round(s * 100) / 100 });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

export interface RefineResult {
  outline: OutlineChapter[];
  /** "2.2 Title (BAB II)" entries dropped as duplicates or dead-ends. */
  removed: string[];
  /** Entries kept but re-pointed at the fallback sources. */
  redirected: string[];
}

/**
 * Sub-bab deduplication & dead-end handling (deterministic, no LLM).
 * Per chapter:
 *  1. Drop duplicate subsection numbers or near-identical titles (≥0.85),
 *     keeping the first occurrence.
 *  2. Drop sourceless subsections when the chapter still has ≥ minSubs;
 *     otherwise redirect them to `fallbackSourceIds` (explicit "search all").
 *  3. Renumber consecutively (X.1, X.2, … by chapter position).
 * Run before drafting — renumbering detaches previously drafted sections.
 */
export function refineOutline(
  outline: OutlineChapter[],
  minSubs: number,
  fallbackSourceIds: string[],
): RefineResult {
  const removed: string[] = [];
  const redirected: string[] = [];
  const backingOf = (s: OutlineSubsection): string[] =>
    s.source_ids ?? s.likely_sources ?? [];
  const cleaned = outline.map((ch) => {
    const seenNums = new Set<string>();
    const keptTitles: string[] = [];
    const kept: OutlineSubsection[] = [];
    for (const sub of ch.subsections) {
      const num = sub.number.trim();
      const dupNum = num ? seenNums.has(num.toLowerCase()) : false;
      const dupTitle = keptTitles.some(
        (t) => sub.title.trim() && titleFuzzyScore(t, sub.title) >= 0.85,
      );
      if (dupNum || dupTitle) {
        removed.push(`${num} ${sub.title} (${ch.chapter_number})`);
        continue;
      }
      if (num) seenNums.add(num.toLowerCase());
      keptTitles.push(sub.title);
      kept.push({ ...sub });
    }
    const live = kept.filter((s) => backingOf(s).length > 0);
    const dead = kept.filter((s) => backingOf(s).length === 0);
    let finalSubs: OutlineSubsection[];
    if (!dead.length) {
      finalSubs = kept;
    } else if (live.length >= minSubs) {
      for (const d of dead) removed.push(`${d.number} ${d.title} (${ch.chapter_number}, tanpa sumber)`);
      finalSubs = live;
    } else {
      for (const d of dead) {
        d.source_ids = [...fallbackSourceIds];
        d.likely_sources = undefined;
        redirected.push(`${d.number} ${d.title} (${ch.chapter_number})`);
      }
      finalSubs = kept;
    }
    return { ...ch, subsections: finalSubs };
  });
  const renumbered = cleaned.map((ch, ci) => ({
    ...ch,
    subsections: ch.subsections.map((s, si) => ({ ...s, number: `${ci + 1}.${si + 1}` })),
  }));
  return { outline: renumbered, removed, redirected };
}

export async function generateOutline(
  input: {
    topic: string;
    language: string;
    academic_level: string;
    source_summaries: SourceSummary[];
    template_constraints: TemplateConstraints;
  },
  sel: InferenceSelection,
): Promise<MakalahOutline> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahOutlineStage);
  // Outline is structure-only: thinking is always off here (it only ever
  // burned budget for zero benefit). Reasoning belongs to drafting.
  const parsed = await chatJson(
    provider, model, MAKALAH_SHARED_SYSTEM, buildOutlineUserPrompt(input),
    sel.numCtx, makalahBudget(sel), parseOutlineJson, "Outline generation",
    false,
  );
  return assertOutlineUsable(parsed);
}

// ---------------------------------------------------------------------------
// Source summaries (outline input) — deterministic, no LLM
// ---------------------------------------------------------------------------

export async function getSourceSummaries(docIds: string[]): Promise<SourceSummary[]> {
  if (!docIds.length) return [];
  const sb = createClient();
  const { data: docs } = await sb
    .from("documents")
    .select("id, title, original_filename, abstract")
    .in("id", docIds);
  const rows = (docs ?? []) as Array<{
    id: string;
    title: string | null;
    original_filename: string | null;
    abstract: string | null;
  }>;
  // Fall back to the first chunk when a doc has no abstract.
  const missing = rows.filter((d) => !(d.abstract ?? "").trim()).map((d) => d.id);
  const firstChunks = new Map<string, string>();
  if (missing.length) {
    const { data: chunks } = await sb
      .from("document_chunks")
      .select("document_id, content, chunk_index")
      .in("document_id", missing)
      .order("chunk_index")
      .limit(missing.length * 2);
    for (const c of (chunks ?? []) as Array<{
      document_id: string;
      content: string;
      chunk_index: number;
    }>) {
      if (!firstChunks.has(c.document_id)) firstChunks.set(c.document_id, c.content);
    }
  }
  return rows.map((d) => ({
    id: d.id,
    title: d.title || d.original_filename || d.id.slice(0, 8),
    abstract_or_excerpt: (
      (d.abstract ?? "").trim() ||
      (firstChunks.get(d.id) ?? "")
    ).slice(0, 600),
  }));
}

// ---------------------------------------------------------------------------
// Retrieval per subsection — deterministic, no LLM
// ---------------------------------------------------------------------------

export async function retrieveForSection(
  query: string,
  scopeIds: string[] | undefined,
  sel: InferenceSelection,
  topK = 8,
  keepTop = 4,
  onStatus?: (stage: string, detail?: string) => void,
): Promise<SectionPassage[]> {
  const ws = await getWorkspaceId();
  onStatus?.("retrieving", query.slice(0, 80));
  const { passages } = await retrieveContext({
    workspaceId: ws,
    query,
    topN: topK,
    embedMode: sel.embedMode,
    scopeIds: scopeIds?.length ? scopeIds : undefined,
    onStatus,
  });
  return passages.slice(0, keepTop).map((p) => ({
    source_id: p.document_id,
    page: p.page,
    paragraph: p.chunk_index ?? null,
    text: p.content,
    score: p.score,
  }));
}

// ---------------------------------------------------------------------------
// Section Generator (once per subsection)
// ---------------------------------------------------------------------------

/**
 * Short opaque aliases (S1, S2, …) stand in for real document ids inside the
 * Section Generator prompt. A raw UUID *looks* like a citation key, which
 * invites the model to paste it into the prose; `S1` doesn't read that way.
 * Mapping is restored (then validated) on the way back out.
 */
function aliasPassages(passages: SectionPassage[]): {
  aliased: SectionPassage[];
  toReal: Map<string, string>;
} {
  const seen = new Map<string, string>();
  const toReal = new Map<string, string>();
  let n = 0;
  for (const p of passages) {
    if (!seen.has(p.source_id)) {
      n += 1;
      seen.set(p.source_id, `S${n}`);
      toReal.set(`S${n}`, p.source_id);
    }
  }
  return {
    aliased: passages.map((p) => ({ ...p, source_id: seen.get(p.source_id)! })),
    toReal,
  };
}

/** Map alias citations back to real ids. Unknown aliases survive untouched so
 *  the citation validator flags them as hallucinated. */
function resolveAliases(output: SectionOutput, toReal: Map<string, string>): SectionOutput {
  return {
    ...output,
    paragraphs: output.paragraphs.map((p) => ({
      ...p,
      citations: p.citations.map((c) => {
        const norm = normalizeAliasCitation(c);
        const real = toReal.get(norm.source_id);
        return real
          ? { source_id: real, page: norm.page ?? c.page }
          : { source_id: norm.source_id, page: norm.page ?? c.page };
      }),
    })),
  };
}

/**
 * Normalize an alias-shaped citation key: case-insensitive (`s2` → `S2`),
 * surrounding brackets stripped (`[S2]` → `S2`), embedded page markers
 * extracted (`S2, h. 47` → key `S2` + page 47). Non-alias keys pass through.
 */
const ALIAS_KEY_RE = /^\[?\s*S(\d+)\s*(?:[,;]\s*(?:p\.?|h\.?|hal\.?|halaman|pp?\.?)\s*(\d+))?\s*\]?$/i;

export function normalizeAliasCitation(c: SectionCitation): SectionCitation {
  const m = c.source_id.trim().match(ALIAS_KEY_RE);
  if (!m) return c;
  return {
    source_id: `S${Number(m[1])}`,
    page: c.page ?? (m[2] ? Number(m[2]) : null),
  };
}

const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PAREN_RE = new RegExp(`\\(\\s*(?:${UUID_SRC})\\s*(?:,\\s*p\\.?\\s*\\d+)?\\s*\\)`, "gi");
const UUID_RE = new RegExp(`\\b(?:${UUID_SRC})\\b`, "gi");
// Page markers in several languages — the model localizes them (Indonesian
// "h." for halaman turned up in the wild as "[S2, h. 5]").
const PAGE_MARK_SRC = "(?:p\\.?|h\\.?|hal\\.?|halaman|pp?\\.?)";
const ALIAS_LEAK_RE = new RegExp(
  `\\[\\s*S\\d+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
  `|\\(\\s*S\\d+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
  "gi",
);
// Multi-alias echoes: "[S2; S5]", "(S2, S5, h. 3)".
const ALIAS_MULTI_RE = new RegExp(
  `\\[\\s*S\\d+(?:\\s*[;,]\\s*S\\d+)+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
  `|\\(\\s*S\\d+(?:\\s*[;,]\\s*S\\d+)+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
  "gi",
);
// Bare inline echoes without brackets: "…populasi S2, h. 47 …"
const ALIAS_BARE_RE = new RegExp(`\\bS\\d+\\s*,\\s*${PAGE_MARK_SRC}\\s*\\d+`, "gi");
// Leftover debris the strict shapes miss ("[S2;]", "[S1,]"). Runs AFTER the
// strict patterns above; the [^A-Za-z…] middle keeps prose like "(S1 orang)" safe.
const ALIAS_DEBRIS_RE = /[[(]\s*S\d+[^A-Za-z[\]()]*[\])]/gi;
// Empty placeholder brackets the model emits when it wants a citation but
// has none ("[]", "[;]", "( )"). Never legit in academic prose.
const EMPTY_CITE_RE = /[[(]\s*[;,\s]*[\])]/g;
// (Smith, 2020) / (Faridah et al., 2021) / (Smith & Jones, 2020) shapes only:
// the comma (or et-al/&-form) requirement keeps legit refs like (UUD 1945) safe.
const AUTHORYEAR_LEAK_RE = /\(\s*[A-Z][\w\-]+(?:\s+et\.?\s*al\.?)?\s*,\s*\d{4}[a-z]?\s*\)|\(\s*[A-Z][\w\-]+\s+(?:&\s*[A-Z][\w\-]+|and\s+[A-Z][\w\-]+|et\.?\s*al\.?)\s*,?\s*\d{4}[a-z]?\s*\)/g;

/**
 * Belt-and-suspenders: strip citation-shaped leakage the model baked into
 * prose (raw UUIDs, alias echoes like `(S1, p. 3)`, author-year echoes like
 * `(Faridah et al., 2021)`). Attribution lives in `citations`, never in text.
 */
export function stripLeakedCitations(text: string): string {
  return text
    .replace(UUID_PAREN_RE, "")
    .replace(UUID_RE, "")
    .replace(ALIAS_MULTI_RE, "")
    .replace(ALIAS_LEAK_RE, "")
    .replace(ALIAS_DEBRIS_RE, "")
    .replace(ALIAS_BARE_RE, "")
    .replace(EMPTY_CITE_RE, "")
    .replace(AUTHORYEAR_LEAK_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * Chunk storage prefixes every chunk with a "[Page N]" marker. Inside a
 * section-generation prompt that marker reads as a citation key, and models
 * copy it into `citations` as source_id "Page" (rendered "[Page, h. 1]" —
 * validator-flagged, but ugly). Strip markers from passage text at
 * prompt-build time only; stored chunks are untouched.
 */
export function cleanPassageForPrompt(text: string): string {
  return (text ?? "").replace(/\[Page \d+\]\n?/gi, "").trim();
}

/**
 * Strip title echoes (`[Full Paper Title, h. 1]`, `(Full Paper Title)`): the
 * model sometimes cites by title string instead of alias, usually echoing a
 * title it saw inside passage text or from training data. Matching is exact
 * (case-insensitive) against known source titles, so only genuine echoes go —
 * and only titles long enough (≥24 chars) that a prose collision is implausible.
 */
export function stripTitleEchoes(text: string, titles: string[]): string {
  const pats = [...new Set(titles.map((t) => (t ?? "").trim()))]
    .filter((t) => t.length >= 24)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const t of pats) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(
        `\\[\\s*${esc}\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
        `|\\(\\s*${esc}\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
        "gi",
      ),
      "",
    );
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/**
 * Base grounding rule per mode. Strict (off) forbids unsupported material;
 * hybrid modes budget a share of model intelligence but keep one hard rule:
 * no "source is missing" meta-sentences in paragraph text, and unsupported
 * paragraphs MUST carry an empty citations array (the quality report counts
 * them as model-bridged instead of pretending they are sourced).
 */
function groundingParagraph(mode: MakalahHybrid): string {
  if (mode === "off") {
    return (
      `You may ONLY use claims that are directly supported by the passages below. ` +
      `Do not introduce facts, statistics, or claims not present in these passages. ` +
      `If the passages are insufficient to write a complete section, write what is ` +
      `supported and note the gap — do not fill it with unsupported material.\n\n`
    );
  }
  const share = mode === "30/70" ? "~30%" : "~15%";
  return (
    `About ${mode === "30/70" ? "70%" : "85%"} of this section must be grounded in the passages below ` +
    `(factual claims cited by alias). The remaining ${share} may be model intelligence ` +
    `(transitions, narrative coherence${mode === "30/70" ? ", theoretical framing, cross-passage synthesis" : ""}) ` +
    `used to keep the section scholarly and complete when the passages are thin.\n\n`
  );
}

function groundingBlock(mode: MakalahHybrid, language: string): string {
  if (mode === "off") return "";
  return (
    `PENTING: Jangan pernah menulis kalimat seperti "tidak ditemukan dalam sumber", ` +
    `"tidak terdapat dalam kutipan", "sumber tidak memuat informasi", atau kalimat ` +
    `senada di dalam teks paragraf. Jika sumber kurang lengkap, gunakan kecerdasan ` +
    `dan wawasan akademik Anda untuk menulis pembahasan yang koheren, ilmiah, dan ` +
    `relevan dari sudut pandang yang paling didukung sumber — dan catat kekurangannya ` +
    `di "gaps" (dalam ${language}, untuk layar drafting penulis, tidak diterbitkan), ` +
    `bukan di "text". Paragraf tanpa dukungan passages WAJIB memakai citations kosong ` +
    `([]) agar laporan kualitas menandainya sebagai model-bridged.\n\n`
  );
}

export function buildSectionUserPrompt(input: {
  topic: string;
  chapter_title: string;
  subsection_number: string;
  subsection_title: string;
  language: string;
  citation_style: string;
  passages: SectionPassage[];
  target_length_words: number;
  /** Full outline ("1.1 T | 1.2 T | 2.1 T") so the model knows its neighbours. */
  full_outline?: string;
  /** Rolling summaries of already-drafted sections ("1.1 ...: <summary>"). */
  prior_context?: string;
  /** This subsection's scope guard (focus + must_not_cover from the outline). */
  scope_note?: string;
  /** Grounding mode: off = strict, 15/85 = coherence bridging, 30/70 = synthesis. */
  grounding?: MakalahHybrid;
}, thinkBudget: number | null = null): string {
  const passages =
    input.passages
      .map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${cleanPassageForPrompt(p.text)}`)
      .join("\n\n") || "(no passages retrieved)";
  const docFrame =
    (input.full_outline?.trim() ? `Full paper outline: ${input.full_outline.trim()}\n` : "") +
    (input.prior_context?.trim()
      ? `Already covered in earlier sections (assume the reader has read them — DO NOT re-explain, ` +
        `build on them; at most one clause like "As discussed in 1.1…" when you must refer back):\n` +
        `${input.prior_context.trim()}\n`
      : "") +
    (input.scope_note?.trim()
      ? `Your scope for THIS section only: ${input.scope_note.trim()} ` +
        `Content belonging to other subsections is out of scope even if the passages mention it.\n`
      : "");
  return (
    `Write section ${input.subsection_number} "${input.subsection_title}" of chapter ` +
    `"${input.chapter_title}" for an academic paper on "${input.topic}", in ${input.language}. ` +
    `Target length: about ${input.target_length_words} words.\n\n` +
    (docFrame ? `${docFrame}\n` : "") +
    (thinkBudget !== null ?
      `Thinking budget: you may spend AT MOST ${thinkBudget} tokens reasoning inside ` +
      `<think> tags before answering, then stop thinking and write the final JSON. ` +
      `Keep deliberation tight — a complete, valid answer matters more than long ` +
      `reasoning, and the total call is capped, so over-thinking truncates your answer.\n\n`
    : "") +
    groundingParagraph(input.grounding ?? "off") +
    groundingBlock(input.grounding ?? "off", input.language) +
    `Passages are labeled with short aliases (S1, S2, …). In the "citations" array, ` +
    `refer to passages ONLY by alias.\n\n` +
    `Passages:\n${passages}\n\n` +
    `Attribution rule (strict): NEVER write a source alias, source id, author name, ` +
    `year, bracketed reference, or an empty placeholder like [] or [;] inside "text" — attribution belongs ONLY in the ` +
    `"citations" array. Bad: "…populasi termiskin (S1, p. 224)." ` +
    `Bad: "…model sangat besar []." ` +
    `Good: "…populasi termiskin."\n\n` +
    `Citation style: ${input.citation_style}. Every factual claim must carry an inline ` +
    `citation pointing to one of the passages above by alias. If a paragraph has no ` +
    `supporting passage, emit it with an empty citations array rather than citing an ` +
    `unrelated source.\n\n` +
    `Return JSON only:\n` +
    `{"paragraphs": [{"text": "...", "citations": [{"source_id": "S1", "page": 7}]}], ` +
    `"gaps": "in ${input.language}: note any part of the topic the given passages don't cover, or empty string (this note is for the author's drafting view only and is never published)"}`
  );
}

export function parseSectionJson(text: string): SectionOutput {
  const obj = extractJsonObject(text);
  const raw = Array.isArray(obj.paragraphs) ? obj.paragraphs : [];
  return {
    paragraphs: raw.map((p) => {
      const para = p as Record<string, unknown>;
      const rawCites = Array.isArray(para.citations) ? para.citations : [];
      return {
        text: String(para.text ?? ""),
        citations: rawCites.map((c) => {
          const cite = c as Record<string, unknown>;
          const page =
            typeof cite.page === "number"
              ? cite.page
              : Number(cite.page) || null;
          return { source_id: String(cite.source_id ?? ""), page };
        }),
      };
    }),
    gaps: typeof obj.gaps === "string" ? obj.gaps : "",
  };
}

export async function generateSection(
  input: {
    topic: string;
    chapter_title: string;
    subsection_number: string;
    subsection_title: string;
    language: string;
    citation_style: string;
    passages: SectionPassage[];
    target_length_words: number;
    /** Known source titles (id → title) for stripping title-echo leaks. */
    source_titles?: Record<string, string>;
    /** Document-level context (outline + already-drafted summaries + scope). */
    outline_context?: {
      full_outline: string;
      prior_summaries: string;
      scope_note?: string;
    };
    /** Grounding mode for this section (default strict). */
    grounding?: MakalahHybrid;
  },
  sel: InferenceSelection,
  signal?: AbortSignal,
): Promise<SectionOutput> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahSectionStage);
  const { aliased, toReal } = aliasPassages(input.passages);
  const echoTitles = Object.values(input.source_titles ?? {});
  const clean = (o: SectionOutput): SectionOutput => ({
    ...o,
    paragraphs: o.paragraphs.map((p) => ({
      ...p,
      text: stripTitleEchoes(stripLeakedCitations(p.text), echoTitles),
    })),
  });
  // Thinking lives ONLY here: outline and claim-check always run cold.
  // When on, drafting is two-phase (both fixed, app-controlled calls):
  //   1. deliberate — thinking enabled, num_predict == think budget (a HARD
  //      cap: Ollama stops generating at the cap, so the trace can never eat
  //      the answer). The trace is kept; any content is a best-effort bonus.
  //   2. answer — thinking disabled with the FULL answer cap, the trace
  //      injected as context. The answer can never starve, by construction.
  // If phase 1 already yields valid JSON content, it is used directly and
  // phase 2 is skipped. If phase 1 fails outright, we fall back to a single
  // cold call. Either way the JSON contract + alias/strip pipeline below holds.
  const thinkingOn = sel.makalahThinking ?? false;
  const thinkBudget = thinkingOn ? makalahThinkBudget(sel) : null;
  const answerCap = makalahBudget(sel);
  const baseUser = buildSectionUserPrompt(
    {
      ...input,
      passages: aliased,
      full_outline: input.outline_context?.full_outline,
      prior_context: input.outline_context?.prior_summaries,
      scope_note: input.outline_context?.scope_note,
      grounding: input.grounding ?? "off",
    },
    thinkBudget,
  );
  const finish = (parsed: SectionOutput): SectionOutput =>
    clean(resolveAliases(parsed, toReal));
  // Salvage ONLY malformed-model-output failures (chatJson tags those with a
  // string `.raw`). Network / provider / auth errors must stay hard errors —
  // silently converting "Ollama offline" into a fake section would be a lie.
  const salvage = (e: unknown): SectionOutput => {
    // Stop/abort is user intent, never salvageable content.
    if (signal?.aborted) throw e;
    const raw = (e as { raw?: unknown }).raw;
    if (typeof raw !== "string") throw e;
    const text = stripTitleEchoes(
      stripLeakedCitations(stripFences(raw).trim()), echoTitles,
    ) || "(model returned empty output)";
    return {
      paragraphs: [{ text, citations: [] }],
      gaps:
        `${SECTION_SALVAGE_MARKER} The model did not return valid JSON even after a retry, ` +
        `so the raw text above is preserved as-is WITHOUT citations. Verify every claim ` +
        `against the retrieved passages manually before keeping this section.`,
    };
  };

  if (thinkBudget === null) {
    try {
      const out = await chatJson(
        provider, model, MAKALAH_SHARED_SYSTEM, baseUser,
        sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
        undefined, signal,
      );
      return finish(out);
    } catch (e) {
      return salvage(e);
    }
  }

  let trace = "";
  try {
    const deliberation = await provider.chat(
      [
        { role: "system", content: MAKALAH_SHARED_SYSTEM },
        { role: "user", content: baseUser },
      ],
      {
        model, temperature: 0, numCtx: sel.numCtx, numPredict: thinkBudget,
        thinking: true, thinkLevel: sel.makalahThinkLevel ?? "low",
        thinkingBudget: thinkBudget,
        ...(signal ? { signal } : {}),
      },
    );
    const content = (deliberation.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (content) {
      try {
        return finish(parseSectionJson(content));
      } catch {
        /* well-formed trace but unusable draft — deliberate below from trace */
      }
    }
    trace = (deliberation.thinking ?? "").trim();
  } catch (e) {
    if (signal?.aborted) throw e;
    trace = ""; // deliberation failed — cold fallback below
  }
  const finalUser = trace
    ? `${baseUser}\n\nYour earlier deliberation (follow it; do not repeat it, output JSON only):\n${trace.slice(0, thinkBudget * 3)}`
    : baseUser;
  try {
    const out = await chatJson(
      provider, model, MAKALAH_SHARED_SYSTEM, finalUser,
      sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
      thinkBudget, signal,
    );
    return finish(out);
  } catch (e) {
    return salvage(e);
  }
}

// ---------------------------------------------------------------------------
// Validation — deterministic code (spec §6 steps 1–3)
// ---------------------------------------------------------------------------

export function validateSectionCitations(
  output: SectionOutput,
  passages: SectionPassage[],
): { ok: boolean; total: number; valid: number; badIds: string[] } {
  const allowed = new Set(passages.map((p) => p.source_id));
  let total = 0;
  let valid = 0;
  const bad = new Set<string>();
  for (const para of output.paragraphs) {
    for (const c of para.citations) {
      total += 1;
      if (c.source_id && allowed.has(c.source_id)) valid += 1;
      else if (c.source_id) bad.add(c.source_id);
    }
  }
  return { ok: bad.size === 0, total, valid, badIds: [...bad] };
}

// ---------------------------------------------------------------------------
// Claim-support check — optional narrow LLM classifier (spec §6 step 4).
// One paragraph + its cited passages -> supported / not_supported.
// No memory of the rest of the document.
// ---------------------------------------------------------------------------

export async function claimSupportCheck(
  paragraphText: string,
  citedPassages: SectionPassage[],
  sel: InferenceSelection,
): Promise<{ verdict: "supported" | "not_supported"; reason: string }> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahSectionStage);
  const evidence =
    citedPassages.map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${cleanPassageForPrompt(p.text)}`).join("\n\n") ||
    "(no cited passages)";
  const user =
    `Answer only "supported" or "not_supported" — does the passage text ` +
    `justify the claim in the paragraph? Return JSON: ` +
    `{"verdict": "...", "reason": "..."}\n\n` +
    `Paragraph:\n${paragraphText}\n\nPassages:\n${evidence}`;
  try {
    const obj = await chatJson<Record<string, unknown>>(
      provider, model, MAKALAH_SHARED_SYSTEM, user,
      sel.numCtx, 512,
      (t) => extractJsonObject(t) as Record<string, unknown>,
      "Claim check",
      false,
    );
    const verdict =
      String(obj.verdict ?? "").toLowerCase().includes("not") ?
        "not_supported"
      : "supported";
    return { verdict, reason: String(obj.reason ?? "") };
  } catch {
    return { verdict: "not_supported", reason: "Classifier output was not valid JSON after retry" };
  }
}

// ---------------------------------------------------------------------------
// Bibliography — deterministic, from stored metadata (APA-ish plain text)
// ---------------------------------------------------------------------------

export async function buildReferences(docIds: string[]): Promise<MakalahReference[]> {
  if (!docIds.length) return [];
  const sb = createClient();
  const { data: docs } = await sb
    .from("documents")
    .select("id, title, original_filename, year, journal, volume, issue, pages, publisher, doi, document_type")
    .in("id", docIds);
  const rows = (docs ?? []) as Array<Record<string, unknown>>;
  // Attach author names for citation rendering.
  const { data: da } = await sb
    .from("document_authors")
    .select("document_id, author_order, authors(name)")
    .in("document_id", docIds)
    .order("author_order");
  const authorsByDoc = new Map<string, string[]>();
  for (const r of (da ?? []) as Array<{
    document_id: string;
    authors: { name: string } | { name: string }[] | null;
  }>) {
    const name = Array.isArray(r.authors) ? r.authors[0]?.name : r.authors?.name;
    if (!name) continue;
    const list = authorsByDoc.get(r.document_id) ?? [];
    list.push(name);
    authorsByDoc.set(r.document_id, list);
  }
  return rows.map((d) => {
    const id = d.id as string;
    // Metadata fallback chain: extracted title → uploaded filename → id stub.
    // A cited source always yields an entry; thin entries are flagged by
    // isMalformedReference in the quality report instead of going missing.
    const title =
      ((d.title as string | null) ?? "").trim() ||
      ((d.original_filename as string | null) ?? "").trim() ||
      `Document ${id.slice(0, 8)}`;
    const item = docToCslItem({
      id,
      title,
      authors: authorsByDoc.get(id) ?? [],
      year: (d.year as number | null) ?? null,
      journal: (d.journal as string | null) ?? null,
      volume: (d.volume as string | null) ?? null,
      issue: (d.issue as string | null) ?? null,
      pages: (d.pages as string | null) ?? null,
      publisher: (d.publisher as string | null) ?? null,
      doi: (d.doi as string | null) ?? null,
      document_type: (d.document_type as string | null) ?? null,
    });
    return { id, formatted_apa7: renderCitationPlain(item) };
  });
}

export async function loadDocTitles(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const { data } = await createClient()
    .from("documents")
    .select("id, title, original_filename")
    .in("id", ids);
  for (const r of (data ?? []) as Array<{
    id: string;
    title: string | null;
    original_filename: string | null;
  }>) {
    map.set(r.id, r.title || r.original_filename || r.id.slice(0, 8));
  }
  return map;
}

export type { HydratedDoc };
