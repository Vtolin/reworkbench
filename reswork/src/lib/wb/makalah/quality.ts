// Makalah quality signals (structure, duplication, grounding).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { sectionSimilarity } from "../../text/similarity";
import type { SectionOutput } from "./types";

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
