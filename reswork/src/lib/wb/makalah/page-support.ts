// Pure page-support helpers for the Makalah drafting UI (Task I).
//
// Moved verbatim from app/makalah/page.tsx so the section/citation logic is
// unit-testable outside the 1700-line client component. No React, no I/O,
// no browser APIs — plain deterministic functions over makalah domain types.
// The page keeps UI state, stream coordination, and export orchestration;
// this module owns the text-shaping rules both sides share.
import type {
  MakalahReference,
  OutlineSubsection,
  SectionOutput,
} from "./types";

export function parseChapterLine(line: string, idx: number): { number: string; title: string } {
  const m = line.trim().match(/^(BAB\s+\S+)\s+([\s\S]*)$/i);
  if (m) return { number: m[1].toUpperCase(), title: (m[2] || line).trim() };
  return { number: `BAB ${idx + 1}`, title: line.trim() };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Walk section outputs and gather every cited source id (single helper for
 *  the memo, refresh, and post-run paths). */
export function citedIdsOf(outputs: Array<SectionOutput | null>): string[] {
  const ids = new Set<string>();
  for (const out of outputs) {
    out?.paragraphs.forEach((p) => p.citations.forEach((c) => {
      if (c.source_id) ids.add(c.source_id);
    }));
  }
  return [...ids];
}

/** Merge fresh references over existing ones without touching entries the
 *  user hand-edited (`manual`) or that are already present. */
export function mergeReferences(prev: MakalahReference[], fresh: MakalahReference[]): MakalahReference[] {
  const have = new Set(prev.map((r) => r.id));
  return [...prev, ...fresh.filter((f) => !have.has(f.id))];
}

/** Deterministic extractive summary: first sentence of each paragraph, capped. */
export function summarizeOutput(output: SectionOutput, maxChars = 900): string {
  const bits: string[] = [];
  for (const p of output.paragraphs) {
    const first = p.text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    if (first) bits.push(first.slice(0, 300));
    if (bits.join("; ").length >= maxChars) break;
  }
  return bits.join("; ").slice(0, maxChars);
}

/**
 * COVERED prior context as labeled bullets (constraints, not prose — prose
 * summaries prime small models to echo the same sentences). Capped so the
 * context can't drown the section's own evidence. Number labels stay so the
 * model can still emit the sanctioned "As discussed in 1.1…" clause.
 */
export function buildPrior(items: Array<{ label: string; summary: string }>, budget = 600): string {
  const lines: string[] = [];
  let len = 0;
  for (const a of items) {
    const line = `- [${a.label}]: ${a.summary}`;
    if (len + line.length > budget && lines.length) break;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join("\n");
}

/** Generic scope guard from outline fields (no topic knowledge). */
export function scopeNoteOf(sub: OutlineSubsection): string {
  const parts: string[] = [];
  if (sub.focus?.trim()) parts.push(`focus: ${sub.focus.trim()}`);
  if (sub.must_not_cover?.length) parts.push(`do NOT cover: ${sub.must_not_cover.join("; ")}`);
  return parts.join(". ");
}

/** Cloud-quota failures need a different action than model bugs. */
export function isQuotaError(msg: string): boolean {
  return /quota|429|rate.?limit|insufficient|exceed|credit|billing|resource_exhausted/i.test(msg);
}
