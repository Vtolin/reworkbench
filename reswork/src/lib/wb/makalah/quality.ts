// Makalah quality signals (structure, duplication, grounding).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { sectionSimilarity } from "../../text/similarity";
import { validateSectionCitations } from "./validation";
import {
  SECTION_SALVAGE_MARKER,
  type MakalahReference,
  type OutlineChapter,
  type OutlineSubsection,
  type QualityReport,
  type SectionOutput,
  type SectionPassage,
} from "./types";

export function isMalformedReference(entry: string): boolean {
  const t = (entry ?? "").trim();
  return !t || t.startsWith("(") || t.includes("..");
}
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

/** Minimal section state the quality report needs (UI persists more). */
export interface QualitySectionState {
  status: string;
  output: SectionOutput | null;
  error?: string | null;
  passages: SectionPassage[];
  integrity: {
    total: number;
    valid: number;
    badIds: string[];
    badPages?: string[];
  } | null;
}

export interface QualityReportInput {
  /** Flat, collision-free section list (chapter + subsection + state key). */
  sections: Array<{ key: string; ch: OutlineChapter; sub: OutlineSubsection }>;
  states: Record<string, QualitySectionState | undefined>;
  references: MakalahReference[];
  citedIds: string[];
  selected: string[];
  outline: OutlineChapter[];
  titleOf: (id: string) => string;
}

/**
 * Build the full quality report from drafted section state. Pure: all
 * identity/title lookups enter through arguments, so this is testable and
 * deterministic for the same inputs.
 */
export function buildQualityReport({
  sections,
  states,
  references,
  citedIds,
  selected,
  outline,
  titleOf,
}: QualityReportInput): QualityReport {
  let total = 0;
  let valid = 0;
  let aiFilled = 0;
  const unsupported: QualityReport["unsupported_claims"] = [];
  const pageMismatches: string[] = [];
  const missingPages: string[] = [];
  // Hallucinated alias ids (S2, S5…) are reported as ✕ unknown below and
  // must NOT also pollute "missing metadata" (they can never resolve to
  // a bibliography entry).
  const badIdSet = new Set<string>();
  let done = 0;

  for (const item of sections) {
    const st = states[item.key];
    if (st?.status === "ok" && st.output) {
      done += 1;
      aiFilled += countAiFilled(st.output);
      if (st.output.gaps.includes(SECTION_SALVAGE_MARKER)) {
        unsupported.push({
          subsection: `${item.sub.number} ${item.sub.title}`,
          paragraph: -1,
          reason: "raw-text fallback (no valid JSON, no citations) — verify manually or regenerate",
        });
      }
      const v = st.integrity ?? validateSectionCitations(st.output, st.passages);
      total += v.total;
      valid += v.valid;
      if (v.badIds.length) {
        v.badIds.forEach((id) => badIdSet.add(id));
        unsupported.push({
          subsection: `${item.sub.number} ${item.sub.title}`,
          paragraph: -1,
          reason: `Cited unknown source id(s): ${v.badIds.join(", ")}`,
        });
      }
      if (v.badPages?.length) {
        pageMismatches.push(`${item.sub.number} ${item.sub.title}: ${v.badPages.join(", ")}`);
      }
      // Soft signal (not an error): citations that drop the page number on a
      // page-verifiable source. Without this, omitting pages is an easy way
      // to dodge the mismatch flag above.
      {
        const verifiable = new Set(st.passages.filter((p) => p.page != null).map((p) => p.source_id));
        const noPage = new Map<string, number>();
        for (const para of st.output.paragraphs) {
          for (const c of para.citations) {
            if (c.page == null && c.source_id && verifiable.has(c.source_id)) {
              noPage.set(c.source_id, (noPage.get(c.source_id) ?? 0) + 1);
            }
          }
        }
        for (const [src, n] of noPage) {
          missingPages.push(`${item.sub.number} ${item.sub.title}: ${titleOf(src)} (${n} tanpa halaman)`);
        }
      }
      if (!st.output.paragraphs.length) {
        unsupported.push({
          subsection: `${item.sub.number} ${item.sub.title}`,
          paragraph: -1,
          reason: "Section generated no paragraphs",
        });
      }
    } else if (st?.status === "error") {
      unsupported.push({
        subsection: `${item.sub.number} ${item.sub.title}`,
        paragraph: -1,
        reason: st.error ?? "Generation failed",
      });
    }
  }

  const refIds = new Set(references.map((r) => r.id));
  const lastCh = outline.length > 1 ? outline[outline.length - 1] : null;
  const redundantPairs = findRedundantPairs(
    sections
      .filter((item) => states[item.key]?.output)
      .map((item) => ({
        label: `${item.sub.number} ${item.sub.title}`,
        text: sectionFullText(states[item.key]!.output!),
        isClosing: !!lastCh && item.ch === lastCh,
      })),
  );

  return {
    structure_complete: sections.length > 0 && done === sections.length,
    citation_integrity_pct: total ? Math.round((valid / total) * 100) : 100,
    citation_total: total,
    unsupported_claims: unsupported,
    missing_references: citedIds.filter((id) => !refIds.has(id) && !badIdSet.has(id)),
    unused_sources: selected.filter((id) => !citedIds.includes(id)),
    malformed_references: references.filter((r) => isMalformedReference(r.formatted_apa7)).map((r) => r.id),
    redundant_pairs: redundantPairs,
    ai_filled: aiFilled,
    citation_page_mismatches: pageMismatches,
    citation_missing_pages: missingPages,
  };
}
