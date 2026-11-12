// Role + evidence helpers shared by generation, drafting UI and export.
// Pure: all outline/section state enters through arguments so the rules
// (closing chapter, synthesis pool, overlap indicator) stay testable.
import { passageKey } from "@/lib/wb/makalah";
import type { OutlineChapter, SectionPassage } from "@/lib/wb/makalah";
import type { FlatItem, SecState } from "./types";

/** True when the section belongs to the last outline chapter (Penutup). */
export function isLastChapterKey(
  flat: FlatItem[],
  outline: OutlineChapter[],
  key: string,
): boolean {
  const item = flat.find((f) => f.key === key);
  // Single-chapter outlines have no "closing" role to play.
  return !!item && outline.length > 1 && item.ch === outline[outline.length - 1];
}

/**
 * Role-aware evidence policy. Synthesis chapters (explicit flag, else last
 * position) must synthesize already-written sections — disjointness is wrong
 * for them: forcing fresh evidence pushes closing subsections off-topic
 * instead of de-duplicating them.
 */
export function isSynthesisKey(
  flat: FlatItem[],
  outline: OutlineChapter[],
  key: string,
): boolean {
  const item = flat.find((f) => f.key === key);
  if (!item || outline.length <= 1) return false;
  return item.ch.synthesis_only ?? item.ch === outline[outline.length - 1];
}

/**
 * Synthesis evidence pool: passages already CITED by drafted sections
 * (matched by source+page, deduped, capped). No retrieval call, no new
 * evidence — the closing chapter can only recombine what exists. Diversity
 * first: one representative passage per drafted section (flat order), so
 * minor sections cannot be silently dropped; remaining slots go to the
 * most-cited passages.
 */
export function synthesisPool(
  flat: FlatItem[],
  states: Record<string, SecState | undefined>,
  excludeKey?: string,
): SectionPassage[] {
  const cited = new Map<string, { p: SectionPassage; n: number; order: number; sec: number }>();
  let order = 0;
  flat.forEach((item, si) => {
    if (excludeKey && item.key === excludeKey) return;
    const st = states[item.key];
    if (st?.status !== "ok" || !st.output) return;
    const wanted = new Set<string>();
    for (const para of st.output.paragraphs) {
      for (const c of para.citations) {
        if (c.source_id) wanted.add(`${c.source_id}::${c.page ?? "?"}`);
      }
    }
    for (const p of st.passages) {
      if (!wanted.has(`${p.source_id}::${p.page ?? "?"}`)) continue;
      const k = passageKey(p);
      const e = cited.get(k);
      if (e) e.n += 1;
      else cited.set(k, { p, n: 1, order: order++, sec: si });
    }
  });
  const vals = [...cited.values()];
  const picked: typeof vals = [];
  const seenSec = new Set<number>();
  for (const v of vals) {
    if (!seenSec.has(v.sec)) {
      seenSec.add(v.sec);
      picked.push(v);
    }
  }
  const ranked = [...vals].sort((a, b) => b.n - a.n || a.order - b.order);
  for (const v of ranked) {
    if (picked.length >= 8) break;
    if (!picked.includes(v)) picked.push(v);
  }
  return picked.slice(0, 8).map((e) => e.p);
}

/**
 * P7 — evidence-overlap leading indicator. Compares stored passages against
 * every other section: predicts duplication before reading any text and
 * separates "retrieval caused this" from "model caused this".
 */
export function overlapNote(
  flat: FlatItem[],
  outline: OutlineChapter[],
  secs: Record<string, SecState | undefined>,
  key: string,
): { text: string; hot: boolean } | null {
  // Synthesis chapters share evidence by design — never an alarm.
  if (isSynthesisKey(flat, outline, key)) {
    const n = secs[key]?.passages.length ?? 0;
    return n ? { text: "sintesis — memakai evidence section sebelumnya", hot: false } : null;
  }
  const own = secs[key]?.passages ?? [];
  if (!own.length) return null;
  const ownKeys = new Set(own.map(passageKey));
  const parts: string[] = [];
  let hot = false;
  for (const item of flat) {
    if (item.key === key) continue;
    const op = secs[item.key]?.passages ?? [];
    if (!op.length) continue;
    const shared = op.filter((p) => ownKeys.has(passageKey(p))).length;
    if (shared > 0) {
      if (shared / own.length > 0.5) hot = true;
      parts.push(`${shared}/${own.length} shared dengan ${item.sub.number}`);
    }
  }
  return parts.length ? { text: parts.join(" · "), hot } : null;
}
