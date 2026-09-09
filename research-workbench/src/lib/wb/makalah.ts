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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface OutlineSubsection {
  number: string;
  title: string;
  /** Mode A proposes `likely_sources`; after approval this becomes `source_ids`. */
  likely_sources?: string[];
  source_ids?: string[];
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
}

export interface QualityReport {
  structure_complete: boolean;
  citation_integrity_pct: number;
  unsupported_claims: Array<{ subsection: string; paragraph: number; reason: string }>;
  missing_references: string[];
  unused_sources: string[];
}

/** Marker placed in `gaps` when a section fell back to raw unstructured text. */
export const SECTION_SALVAGE_MARKER = "[unstructured-fallback]";

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
  thinking = false,
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
      { model, temperature: 0, numCtx, numPredict, thinking },
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
    `For each subsection, list which source ids plausibly support it (you are not ` +
    `writing content yet, only proposing structure and mapping likely evidence). ` +
    `Copy each source id EXACTLY as shown above — never abbreviate, renumber, or ` +
    `invent ids like "paper_01".\n\n` +
    `Return JSON only, in this schema:\n` +
    `{"outline": [{"chapter_number": "BAB I", "chapter_title": "Pendahuluan", ` +
    `"subsections": [{"number": "1.1", "title": "Latar Belakang", ` +
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
        return {
          number: String(sub.number ?? ""),
          title: String(sub.title ?? ""),
          ...(likely ? { likely_sources: likely } : {}),
          ...(ids ? { source_ids: ids } : {}),
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
  const parsed = await chatJson(
    provider, model, MAKALAH_SHARED_SYSTEM, buildOutlineUserPrompt(input),
    sel.numCtx, makalahBudget(sel), parseOutlineJson, "Outline generation",
    sel.makalahThinking ?? false,
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

export function buildSectionUserPrompt(input: {
  topic: string;
  chapter_title: string;
  subsection_number: string;
  subsection_title: string;
  language: string;
  citation_style: string;
  passages: SectionPassage[];
  target_length_words: number;
}): string {
  const passages =
    input.passages
      .map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${p.text}`)
      .join("\n\n") || "(no passages retrieved)";
  return (
    `Write section ${input.subsection_number} "${input.subsection_title}" of chapter ` +
    `"${input.chapter_title}" for an academic paper on "${input.topic}", in ${input.language}. ` +
    `Target length: about ${input.target_length_words} words.\n\n` +
    `You may ONLY use claims that are directly supported by the passages below. ` +
    `Do not introduce facts, statistics, or claims not present in these passages. ` +
    `If the passages are insufficient to write a complete section, write what is ` +
    `supported and note the gap — do not fill it with unsupported material.\n\n` +
    `Passages:\n${passages}\n\n` +
    `Citation style: ${input.citation_style}. Every factual claim must carry an inline ` +
    `citation pointing to one of the passages above by source_id. If a paragraph has no ` +
    `supporting passage, emit it with an empty citations array rather than citing an ` +
    `unrelated source.\n\n` +
    `Return JSON only:\n` +
    `{"paragraphs": [{"text": "...", "citations": [{"source_id": "paper_04", "page": 7}]}], ` +
    `"gaps": "note any part of the topic the given passages don't cover, or empty string"}`
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
  },
  sel: InferenceSelection,
): Promise<SectionOutput> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahSectionStage);
  try {
    return await chatJson(
      provider, model, MAKALAH_SHARED_SYSTEM, buildSectionUserPrompt(input),
      sel.numCtx, makalahBudget(sel), parseSectionJson, "Section generation",
      sel.makalahThinking ?? false,
    );
  } catch (e) {
    // Salvage ONLY malformed-model-output failures (chatJson tags those with a
    // string `.raw`). Network / provider / auth errors must stay hard errors —
    // silently converting "Ollama offline" into a fake section would be a lie.
    const raw = (e as { raw?: unknown }).raw;
    if (typeof raw !== "string") throw e;
    const text = stripFences(raw).trim() || "(model returned empty output)";
    return {
      paragraphs: [{ text, citations: [] }],
      gaps:
        `${SECTION_SALVAGE_MARKER} The model did not return valid JSON even after a retry, ` +
        `so the raw text above is preserved as-is WITHOUT citations. Verify every claim ` +
        `against the retrieved passages manually before keeping this section.`,
    };
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
    citedPassages.map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${p.text}`).join("\n\n") ||
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
      sel.makalahThinking ?? false,
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
    .select("id, title, year, journal, volume, issue, pages, publisher, doi, document_type")
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
    const item = docToCslItem({
      id,
      title: (d.title as string | null) ?? null,
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
