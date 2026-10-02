// Makalah domain types + shared constants.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.

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

/**
 * Boundary mapper: a retrieved RAG passage → makalah section evidence.
 * Single owner (this module): retrieval must not cast inline. chunk_index
 * becomes the paragraph slot; score carries through for MMR/diversity.
 */
export function toSectionPassage(raw: {
  document_id: string;
  page: number | null;
  chunk_index: number | null;
  content: string;
  score: number;
}): SectionPassage {
  return {
    source_id: raw.document_id,
    page: raw.page,
    paragraph: raw.chunk_index ?? null,
    text: raw.content,
    score: raw.score,
  };
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
export interface OutlineContext {
  full_outline: string;
  prior_summaries: string;
  scope_note?: string;
  /** Verbatim sentences from the most-similar drafted section: never repeat. */
  negative_list?: string;
  /** True for the closing chapter (Penutup): synthesis contract, no new claims. */
  is_last_chapter?: boolean;
}
