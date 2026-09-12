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
import { sectionSimilarity, mmrSelect } from "@/lib/text/similarity";

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
  /** Closing chapters synthesize prior sections: no new evidence allowed. */
  synthesis_only?: boolean;
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
  /** Citations with page numbers that don't match any retrieved passage for that source. */
  citation_page_mismatches: string[];
  /** Citations that omit the page on a page-verifiable source (soft signal). */
  citation_missing_pages: string[];
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

/** Escape raw/unescaped control characters (\n, \r, \t) inside double-quoted string literals. */
function escapeControlCharsInStrings(text: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

/**
 * Repair conservatively:
 * 1. Escape raw unescaped control characters (\n, \r, \t) inside string
 *    literals (LLMs emit literal newlines; JSON.parse rejects them).
 * 2. Remove trailing commas before } or ] — the most common LLM JSON defect.
 *
 * Deliberately NOT normalizing single-quoted JSON: the '…'-to-"…" rewrite
 * corrupts legitimate apostrophes (Today's, peneliti's) whenever a model
 * answers with zero double-quotes, turning a recoverable parse into silent
 * text corruption. A single-quoted answer fails fast with an actionable
 * message instead.
 */
export function repairJson(text: string): string {
  let res = text;
  res = escapeControlCharsInStrings(res);
  res = res.replace(/,(\s*[}\]])/g, "$1");
  return res;
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
  think: boolean | "minimal" | "low" | "medium" | "high" | "max" = false,
  thinkingBudget?: number,
  signal?: AbortSignal,
  temperature = 0,
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
        model, temperature, numCtx, numPredict, thinking: think !== false,
        ...(typeof think === "string" ? { thinkLevel: think } : {}),
        // A bare budget ENABLES thinking on Gemini — only send it together
        // with thinking on, never on cold calls. Cold calls send
        // thinking:false explicitly so the proxy maps to minimal/0 instead
        // of the provider default (medium on gemini-3.5-flash).
        ...(think !== false && typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
        // Structured output on cloud (OpenAI-compat response_format).
        // Ollama ignores unknown flags — it enforces JSON via prompt.
        jsonMode: true,
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
    `Copy each source id EXACTLY as shown in the list above — paste the full ` +
    `string verbatim. Never abbreviate, renumber, shorten, or invent ids.\n\n` +
    `Return JSON only, in this schema (the likely_sources values below are ` +
    `PLACEHOLDERS showing shape only — always replace them with real ids ` +
    `pasted from the list above):\n` +
    `{"outline": [{"chapter_number": "BAB I", "chapter_title": "Pendahuluan", ` +
    `"subsections": [{"number": "1.1", "title": "Latar Belakang", ` +
    `"focus": "why this topic matters", "must_not_cover": ["detailed theory"], ` +
    `"likely_sources": ["<paste-exact-id-from-list-above>", "<paste-another-exact-id>"]}]}, ` +
    `{"chapter_number": "BAB III", "chapter_title": "Penutup", "synthesis_only": true, ` +
    `"subsections": [...]}], ` +
    `"coverage_notes": "any themes in the sources not reflected in the outline, or gaps"}\n\n` +
    `Mark the final chapter (Penutup — conclusions and suggestions only) with ` +
    `"synthesis_only": true: it must synthesize already-covered material and ` +
    `receive no new evidence.`
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
      ...(ch.synthesis_only === true ? { synthesis_only: true as const } : {}),
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
  // must_not_cover names OTHER sections' topics — including it would inflate
  // every pair sharing vocabulary. Score what the section IS (title+focus).
  return [sub.title, sub.focus ?? ""].join(" ");
}

type OutlineRole = "open" | "middle" | "close";

/**
 * Outline-overlap gate (advisory, not blocking), scored on content words —
 * raw bigrams over Indonesian academic titles ("Perkembangan LLM",
 * "Penggunaan LLM") routinely hit 0.5–0.7 with no real meaning overlap.
 * Same-role pairs (esp. within Pembahasan, the real duplication zone) warn
 * at `threshold`; cross-role pairs are partly structural (a scope preview in
 * BAB I legitimately echoes a BAB II topic) and warn only above
 * `crossRoleThreshold`. A genuinely leaky scope (preview ≈ full treatment)
 * is then caught downstream by focus discipline and the P7 evidence-overlap
 * indicator at drafting time. Detector quality scales with focus quality:
 * empty Fokus leaves titles alone to discriminate on.
 * Thresholds are set above the 0.85–0.88 boilerplate band observed on
 * broad Indonesian topics so only genuine duplication warns.
 */
export function findOutlineOverlaps(
  outline: OutlineChapter[],
  threshold = 0.78,
  crossRoleThreshold = 0.82,
): Array<{ a: string; b: string; score: number }> {
  const roleOf = (ci: number): OutlineRole =>
    outline.length > 1 && ci === outline.length - 1 ? "close"
    : ci === 0 ? "open"
    : "middle";
  const flat = outline.flatMap((ch, ci) =>
    ch.subsections.map((sub) => ({
      label: outlineSubLabel(ch.chapter_number, sub),
      text: outlineScopeText(sub),
      role: roleOf(ci),
    })),
  );
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const bar = flat[i].role === flat[j].role ? threshold : crossRoleThreshold;
      const s = sectionSimilarity(flat[i].text, flat[j].text);
      if (s >= bar) out.push({ a: flat[i].label, b: flat[j].label, score: Math.round(s * 100) / 100 });
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
 * Generic cross-section duplication detector over content-word similarity
 * (function words stripped — see lib/text/similarity). Pairs involving the
 * closing chapter use a higher bar: Penutup restates by job description, so
 * mid-0.8s there is role overlap, not evidence overlap. The default bar sits
 * above the 0.85–0.88 Indonesian-boilerplate band seen on broad topics.
 * Advisory — the UI lists pairs above threshold for Regenerate/Edit.
 */
export function findRedundantPairs(
  sections: Array<{ label: string; text: string; isClosing?: boolean }>,
  threshold = 0.88,
  closingThreshold = 0.94,
): Array<{ a: string; b: string; score: number }> {
  // Bounded: quality recomputes on every secs change (autosave keystrokes),
  // and chapters are unbounded — cap sections before the O(S²·P²) comparison.
  const usable = sections.filter((s) => s.text.trim().length > 40).slice(0, 24);
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const bar =
        usable[i].isClosing || usable[j].isClosing ? closingThreshold : threshold;
      const s = sectionSimilarity(usable[i].text, usable[j].text);
      if (s >= bar) out.push({ a: usable[i].label, b: usable[j].label, score: Math.round(s * 100) / 100 });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * Deterministic verbatim-sentence extractor for the negative list: leading
 * sentences across paragraphs, capped. No LLM, no topic knowledge.
 */
export function buildNegativeList(output: SectionOutput, maxChars = 400): string {
  const sents: string[] = [];
  let len = 0;
  for (const p of output.paragraphs) {
    for (const s of p.text.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (t.length < 20) continue;
      sents.push(t);
      len += t.length + 1;
      if (len >= maxChars) break;
    }
    if (len >= maxChars) break;
  }
  return sents.join(" ").slice(0, maxChars);
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

/**
 * Stable identity for a retrieved passage. Single key space shared by the
 * allocator (excludeKeys), the UI (used-tracking, overlap display) and the
 * validator — never introduce a second key format.
 */
export function passageKey(p: {
  source_id: string;
  page: number | null;
  paragraph: number | null;
}): string {
  return `${p.source_id}::${p.page ?? "?"}::${p.paragraph ?? "?"}`;
}

export async function retrieveForSection(
  query: string,
  scopeIds: string[] | undefined,
  sel: InferenceSelection,
  topK = 8,
  keepTop = 4,
  onStatus?: (stage: string, detail?: string) => void,
  excludeKeys?: Set<string>,
): Promise<SectionPassage[]> {
  const ws = await getWorkspaceId();
  onStatus?.("retrieving", query.slice(0, 80));
  // Widen BEFORE selecting when exclusions exist: post-slice reordering can
  // only permute an already-truncated set, so without a wider pool the
  // "prefer fresh evidence" policy is cosmetic.
  const fetchN = excludeKeys?.size ? Math.max(topK, keepTop * 3) : topK;
  const { passages } = await retrieveContext({
    workspaceId: ws,
    query,
    topN: fetchN,
    embedMode: sel.embedMode,
    scopeIds: scopeIds?.length ? scopeIds : undefined,
    onStatus,
  });
  const pool = passages.map((p, i) => ({
    passage: {
      source_id: p.document_id,
      page: p.page,
      paragraph: p.chunk_index ?? null,
      text: p.content,
      score: p.score,
    } as SectionPassage,
    rank: i,
  }));
  const fresh = excludeKeys?.size
    ? pool.filter(({ passage }) => !excludeKeys.has(passageKey(passage)))
    : pool;
  // Starvation backfill: an exhausted pool reuses evidence in rank order
  // rather than returning empty (empty would trigger the broaden-fallback
  // loop). Callers detect this by comparing returned keys to excludeKeys.
  const selectable = fresh.length ? fresh : pool;
  const picked = mmrSelect(
    selectable.map(({ passage, rank }) => ({
      key: passageKey(passage),
      relevance: passage.score,
      rank,
      text: passage.text,
      passage,
    })),
    keepTop,
  ).map((x) => (x as { passage: SectionPassage }).passage);
  return picked;
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
// Bare numeric brackets the model emits as pseudo-citations ("[483]",
// "[6, 21]" — IEEE-looking echoes from small models). Never legit here:
// attribution lives ONLY in the `citations` array, and rendered cites always
// carry a title ("[Title, h. X]"), never a bare number. Paren-form "(483)"
// is deliberately NOT matched — bare paren numbers collide with real prose.
const NUMERIC_CITE_RE = /\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]/g;
// Empty placeholder brackets the model emits when it wants a citation but
// has none ("[]", "[;]", "( )"). Never legit in academic prose.
const EMPTY_CITE_RE = /[[(]\s*[;,\s]*[\])]/g;
// (Smith, 2020) / (Faridah et al., 2021) / (Smith & Jones, 2020) shapes only:
// the comma (or et-al/&-form) requirement keeps legit refs like (UUD 1945) safe.
const AUTHORYEAR_LEAK_RE = /\(\s*[A-Z][\w\-]+(?:\s+et\.?\s*al\.?)?\s*,\s*\d{4}[a-z]?\s*\)|\(\s*[A-Z][\w\-]+\s+(?:&\s*[A-Z][\w\-]+|and\s+[A-Z][\w\-]+|et\.?\s*al\.?)\s*,?\s*\d{4}[a-z]?\s*\)/g;

/**
 * Belt-and-suspenders: strip citation-shaped leakage the model baked into
 * prose (raw UUIDs, alias echoes like `(S1, p. 3)`, bare numeric echoes like
 * `[483]` / `[6, 21]`, author-year echoes like `(Faridah et al., 2021)`).
 * Attribution lives in `citations`, never in text.
 */
export function stripLeakedCitations(text: string): string {
  return text
    .replace(UUID_PAREN_RE, "")
    .replace(UUID_RE, "")
    .replace(ALIAS_MULTI_RE, "")
    .replace(ALIAS_LEAK_RE, "")
    .replace(ALIAS_DEBRIS_RE, "")
    .replace(ALIAS_BARE_RE, "")
    .replace(NUMERIC_CITE_RE, "")
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
 * Post-generation defect detectors (deterministic, topic-generic).
 * Used for one bounded correction retry: the model gets its defects listed
 * back and one chance to fix them. Still app-controlled (max 1 extra call).
 */

/** Source-gap meta-sentences that belong in `gaps`, never in paragraph text.
 *  Narrowly scoped to source-referencing phrases — paper-scope statements
 *  ("Penelitian ini tidak akan membahas…") are legitimate and NOT matched. */
const GAP_LEAK_PATTERNS: RegExp[] = [
  /tidak\s+ditemukan\s+dalam\s+sumber/i,
  /tidak\s+terdapat\s+dalam\s+(sumber|kutipan)/i,
  /tidak\s+ditemukan\s+dalam\s+kutipan/i,
  /sumber\s+tidak\s+(memuat|menyediakan|mencakup|memberikan)/i,
  /dokumen\s+acuan\s+tidak/i,
  /literatur\s+yang\s+tersedia[^.]{0,80}belum\s+merinci/i,
  /not\s+found\s+in\s+the\s+(source|passage|citation)/i,
  /not\s+mentioned\s+in\s+the\s+(source|passage|citation)/i,
  /(sources?|passages?)\s+do\s+not\s+provide/i,
  /no\s+information[^.]{0,60}in\s+the\s+passages/i,
];

export function containsGapLeak(text: string): boolean {
  const t = text ?? "";
  return GAP_LEAK_PATTERNS.some((re) => re.test(t));
}

/** True when prose still carries citation-shaped leakage (aliases, bare
 *  numeric brackets, UUIDs, author-year echoes, empty placeholders). Runs on
 *  raw model text BEFORE stripping — after stripping there is nothing left
 *  to detect. */
export function hasCitationLeak(text: string): boolean {
  const t = text ?? "";
  // All leak patterns are global (/g/): reset lastIndex before each test
  // since .test() on a /g/ regex is stateful.
  for (const re of [ALIAS_MULTI_RE, ALIAS_LEAK_RE, ALIAS_BARE_RE, NUMERIC_CITE_RE, UUID_RE, EMPTY_CITE_RE, AUTHORYEAR_LEAK_RE]) {
    re.lastIndex = 0;
    if (re.test(t)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/** Citations with no usable source key (renders as "[, 61]").
 *  Page hallucinations are deliberately NOT judged by absolute size here:
 *  printed-page corpora (e.g. ACL Findings pp. 12834–12854) legitimately
 *  exceed any fixed cap, so a `>5000` rule would false-positive and make the
 *  correction retry "fix" a correct page. Wrong pages are caught exactly by
 *  badPages instead (the cited page must occur in the retrieved passages for
 *  that source; page-less sources stay unverifiable and unflagged). */
export function hasEmptyCitation(output: SectionOutput): boolean {
  for (const p of output.paragraphs ?? []) {
    for (const c of p.citations ?? []) {
      const key = (c.source_id ?? "").trim();
      if (!key) return true;
      if (/^[,;\s\d]+$/.test(key)) return true;
    }
  }
  return false;
}

/**
 * NOTE FOR FUTURE TUNERS:
 * There is an intentional design tension between MAKALAH_SHARED_SYSTEM ("never invent facts... to fill a gap")
 * and the 15/85 / 30/70 grounding blocks below ("use academic intelligence/insight when sources are thin").
 * The mitigations in place (mandatory empty citations [] on unsupported paragraphs, ai_filled surfaced in
 * the QualityReport, human verification before export) balance strict citation hygiene with drafting flow.
 */

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
  const isID = language.toLowerCase().startsWith("id");
  if (isID) {
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
  return (
    `IMPORTANT: Never write phrases like "not found in the source", "not mentioned in the citations", ` +
    `"the sources do not provide information", or similar meta-commentary inside paragraph text. ` +
    `If the sources are incomplete, use your academic intelligence and insight to write a coherent, ` +
    `scholarly, and relevant discussion from the perspective best supported by the available sources — ` +
    `and record any gaps in "gaps" (in ${language}, for the author's drafting view only, not published), ` +
    `not in "text". Paragraphs without passage support MUST carry an empty citations array ` +
    `([]) so the quality report marks them as model-bridged.\n\n`
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
  /** Verbatim sentences from the most-similar drafted section: never repeat. */
  negative_list?: string;
  /** True for the closing chapter: synthesis contract, no new claims. */
  is_last_chapter?: boolean;
  /** Grounding mode: off = strict, 15/85 = coherence bridging, 30/70 = synthesis. */
  grounding?: MakalahHybrid;
}, thinkBudget: number | null = null, thinkTags = true): string {
  const passages =
    input.passages
      .map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${cleanPassageForPrompt(p.text)}`)
      .join("\n\n") || "(no passages retrieved)";
  // The exact alias range for this call — naming it kills invented S5/S6-style
  // citations at the source (the validator can only flag them afterwards).
  const validAliases = [...new Set(input.passages.map((p) => p.source_id))];
  const hasPrior = !!input.prior_context?.trim() || !!input.negative_list?.trim();
  const docFrame =
    (input.full_outline?.trim() ? `Full paper outline: ${input.full_outline.trim()}\n` : "") +
    // COVERED bullets read as constraints ("do not restate"), where the old
    // prose summaries ("already covered… build on them") primed small models
    // to echo the same sentences back. Number labels stay so the sanctioned
    // one-clause reference ("As discussed in 1.1…") remains possible.
    (input.prior_context?.trim()
      ? `COVERED — the following is already in the paper. Do not restate or paraphrase ` +
        `any of it; assume the reader has read it. One short clause like "As discussed ` +
        `in 1.1…" is allowed only when you must refer back:\n` +
        `${input.prior_context.trim()}\n`
      : "") +
    (input.negative_list?.trim()
      ? `The following sentences already exist verbatim earlier in this paper. ` +
        `Do not repeat or paraphrase them — write around them:\n` +
        `${input.negative_list.trim()}\n`
      : "") +
    (input.is_last_chapter
      ? `This is the closing chapter (Penutup): do not introduce new evidence or new ` +
        `claims. Each paragraph must COMBINE findings from at least two earlier sections ` +
        `into a new statement; do not reuse sentence structures or opening phrases from ` +
        `earlier sections.\n`
      : "") +
    (input.scope_note?.trim()
      ? `Your scope for THIS section only: ${input.scope_note.trim()} ` +
        `Content belonging to other subsections is out of scope even if the passages mention it.\n`
      : "") +
    // Step-shaped instruction for the deliberation phase: norms ("don't
    // re-explain") wash out under small thinking budgets, checklists survive.
    // Provider-agnostic: useful with or without native thinking, so it is
    // included whenever prior context exists (previously gated on thinking,
    // which left cloud-cold calls without it).
    (hasPrior
      ? `Deliberation instruction: first list which retrieved passages overlap the ` +
        `COVERED list above; plan this section only around the remaining passages.\n`
      : "");
  return (
    `Write section ${input.subsection_number} "${input.subsection_title}" of chapter ` +
    `"${input.chapter_title}" for an academic paper on "${input.topic}", in ${input.language}. ` +
    `Target length: about ${input.target_length_words} words.\n\n` +
    (docFrame ? `${docFrame}\n` : "") +
    (thinkBudget !== null && thinkTags ?
      `Thinking budget: you may spend AT MOST ${thinkBudget} tokens reasoning inside ` +
      `<think> tags before answering, then stop thinking and write the final JSON. ` +
      `Keep deliberation tight — a complete, valid answer matters more than long ` +
      `reasoning, and the total call is capped, so over-thinking truncates your answer.\n\n`
    : thinkBudget !== null ?
      // Cloud/native thinking: no <think> tags (the JSON parser strips them).
      // Reason natively within budget, then output JSON only.
      `Deliberation budget: reason natively within AT MOST ${thinkBudget} thinking tokens, ` +
      `then stop and write the final JSON with no reasoning preamble and no ` +
      `<think> tags. A complete, valid answer matters more than long reasoning.\n\n`
    : "") +
    groundingParagraph(input.grounding ?? "off") +
    groundingBlock(input.grounding ?? "off", input.language) +
    `Passages are labeled with short aliases (S1, S2, …). In the "citations" array, ` +
    `refer to passages ONLY by alias. ` +
    `Valid aliases for THIS section: ${validAliases.join(", ") || "(none — emit every paragraph with an empty citations array)"}. ` +
    `Never invent other aliases — unknown keys are rejected and the section is flagged.\n\n` +
    `Passages:\n${passages}\n\n` +
    `Attribution rule (strict): NEVER write a source alias, source id, author name, ` +
    `year, bracketed reference, or an empty placeholder like [] or [;] inside "text" — attribution belongs ONLY in the ` +
    `"citations" array. Bad: "…populasi termiskin (S1, p. 224)." ` +
    `Bad: "…model sangat besar []." ` +
    `Good: "…populasi termiskin."\n\n` +
    `Citation style: ${input.citation_style}. Every factual claim must carry an inline ` +
    `citation pointing to one of the passages above by alias. Always copy the page ` +
    `number shown with each passage into "page"; use null only when the passage ` +
    `shows none — never drop a shown page number. If a paragraph has no ` +
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

/** Document-level context threaded into section drafting (all optional). */
export interface OutlineContext {
  full_outline: string;
  prior_summaries: string;
  scope_note?: string;
  /** Verbatim sentences from the most-similar drafted section: never repeat. */
  negative_list?: string;
  /** True for the closing chapter (Penutup): synthesis contract, no new claims. */
  is_last_chapter?: boolean;
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
    outline_context?: OutlineContext;
    /** Grounding mode for this section (default strict). */
    grounding?: MakalahHybrid;
    /** Sampling temperature (default 0 = deterministic; small values only on explicit retry). */
    temperature?: number;
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
  const answerTemp = input.temperature ?? 0;
  // Native <think> tags are an Ollama convention. Cloud models reason via
  // thinking_config and must never emit literal tags (the parser strips them).
  const thinkTags = provider.id === "ollama";
  const thinkLevel = sel.makalahThinkLevel ?? "low";
  // Ollama has no "minimal" level (400 on unknown think values) — closest is
  // a brief "low" trace. Cloud (Gemini 3) keeps "minimal" as closest-to-off.
  const deliberationLevel = provider.id === "ollama" && thinkLevel === "minimal" ? "low" : thinkLevel;
  const baseUser = buildSectionUserPrompt(
    {
      ...input,
      passages: aliased,
      full_outline: input.outline_context?.full_outline,
      prior_context: input.outline_context?.prior_summaries,
      scope_note: input.outline_context?.scope_note,
      negative_list: input.outline_context?.negative_list,
      is_last_chapter: input.outline_context?.is_last_chapter,
      grounding: input.grounding ?? "off",
    },
    thinkBudget,
    thinkTags,
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

  // One bounded correction retry for deterministic defects (unknown ids,
  // page mismatches, empty citations, citation leaks in prose, gap-leaks in
  // prose). The model gets its defects listed back and one chance to fix
  // them — still fully app-controlled (max 1 extra call, fixed prompt shape,
  // no autonomy). Never throws: a failed correction keeps the first draft
  // (only unparsable model output salvages, via salvage() at the call sites).
  const defectList = (out: SectionOutput): string[] => {
    const defects: string[] = [];
    const v = validateSectionCitations(out, input.passages);
    if (v.badIds.length) defects.push(`unknown source ids (not in retrieved passages): ${v.badIds.slice(0, 6).join(", ")}`);
    if (v.badPages.length) defects.push(`pages not present in retrieved passages: ${v.badPages.slice(0, 6).join(", ")}`);
    if (hasEmptyCitation(out)) defects.push('empty source key (renders as "[, N]")');
    const leaked = (out.paragraphs ?? []).find((p) => containsGapLeak(p.text));
    if (leaked) defects.push(`source-gap meta-sentence in paragraph text (belongs in "gaps", never in "text")`);
    return defects;
  };
  // Leak check runs on PARSED output before clean(): finish() strips leaks,
  // so checking the finished draft would always pass. A stripped leak still
  // ships readable text, but the correction reinforces the attribution rule.
  const rawHadLeak = (parsed: SectionOutput): boolean =>
    (parsed.paragraphs ?? []).some((p) => hasCitationLeak(p.text));
  const LEAK_DEFECT = `bracketed citation-shaped text inside paragraphs (aliases, bare numbers, years — attribution belongs ONLY in the "citations" array)`;
  const maybeCorrect = async (first: SectionOutput, prompt: string, firstHadLeak = false): Promise<SectionOutput> => {
    const defects = defectList(first);
    if (firstHadLeak) defects.push(LEAK_DEFECT);
    if (!defects.length || signal?.aborted) return first;
    const correction =
      `${prompt}\n\nCORRECTION — your previous draft had these defects:\n` +
      defects.map((d) => `- ${d}`).join("\n") +
      `\nFix them: cite ONLY aliases from the Valid aliases list with their shown page ` +
      `numbers (copy exactly, never invent pages); never write bracketed references, ` +
      `aliases, or years inside "text"; put source-gap commentary in "gaps", ` +
      `never in "text"; every paragraph needs at least one valid citation or an empty ` +
      `array. Output JSON only.`;
    try {
      const out = await chatJson(
        provider, model, MAKALAH_SHARED_SYSTEM, correction,
        sel.numCtx, answerCap, parseSectionJson, "Section correction", false,
        undefined, signal, answerTemp,
      );
      const second = finish(out);
      const secondDefects = defectList(second);
      if (rawHadLeak(out)) secondDefects.push(LEAK_DEFECT);
      // Keep whichever draft has fewer defects (never regress).
      return secondDefects.length < defects.length ? second : first;
    } catch (e) {
      // User stop must propagate — never convert an abort into a kept draft.
      if (signal?.aborted) throw e;
      return first;
    }
  };

  if (thinkBudget === null) {
    try {
      const out = await chatJson(
        provider, model, MAKALAH_SHARED_SYSTEM, baseUser,
        sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
        undefined, signal, answerTemp,
      );
      return await maybeCorrect(finish(out), baseUser, rawHadLeak(out));
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
        thinking: true, thinkLevel: deliberationLevel,
        thinkingBudget: thinkBudget,
        jsonMode: true,
        ...(signal ? { signal } : {}),
      },
    );
    const content = (deliberation.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (content) {
      try {
        const parsed = parseSectionJson(content);
        return await maybeCorrect(finish(parsed), baseUser, rawHadLeak(parsed));
      } catch {
        /* well-formed trace but unusable draft — deliberate below from trace */
      }
    }
    // Cloud parity: CloudProvider now returns a native `thinking` trace when
    // the proxy surfaces one; Ollama returns it directly. Either way the
    // trace is injected as context — never discarded.
    trace = (deliberation.thinking ?? "").trim();
  } catch (e) {
    if (signal?.aborted) throw e;
    trace = ""; // deliberation failed — cold fallback below
  }
  const finalUser = trace
    ? `${baseUser}\n\nYour earlier deliberation (follow it; do not repeat it, output JSON only):\n${trace.slice(0, (thinkBudget ?? 1024) * 3)}`
    : baseUser;
  try {
    const out = await chatJson(
      provider, model, MAKALAH_SHARED_SYSTEM, finalUser,
      sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
      thinkBudget, signal, answerTemp,
    );
    return await maybeCorrect(finish(out), finalUser, rawHadLeak(out));
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
): { ok: boolean; total: number; valid: number; badIds: string[]; badPages: string[] } {
  const allowed = new Set(passages.map((p) => p.source_id));
  const validPages = new Set(
    passages
      .filter((p) => p.page !== null && p.page !== undefined)
      .map((p) => `${p.source_id}@p.${p.page}`),
  );
  // Sources whose passages carry no page info at all (legacy chunks ingested
  // before page-aware chunking) cannot be page-verified — flagging every
  // cited page for them is a false-positive wall, so skip those sources.
  const unverifiable = new Set(
    [...allowed].filter(
      (id) => !passages.some((p) => p.source_id === id && p.page !== null && p.page !== undefined),
    ),
  );
  let total = 0;
  let valid = 0;
  const bad = new Set<string>();
  const badPages = new Set<string>();
  for (const para of output.paragraphs) {
    for (const c of para.citations) {
      total += 1;
      if (c.source_id && allowed.has(c.source_id)) {
        valid += 1;
        if (c.page !== null && c.page !== undefined && !unverifiable.has(c.source_id)) {
          const key = `${c.source_id}@p.${c.page}`;
          if (!validPages.has(key)) {
            badPages.add(key);
          }
        }
      } else if (c.source_id) {
        bad.add(c.source_id);
      }
    }
  }
  return { ok: bad.size === 0, total, valid, badIds: [...bad], badPages: [...badPages] };
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
