// Makalah outline: overlap gate, refinement, generation (Mode A).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { titleFuzzyScore } from "../../ingestion/dedup";
import { sectionSimilarity } from "../../text/similarity";
import type { InferenceSelection } from "../ask";
import { chatJson, parseOutlineJson } from "./json";
import { MAKALAH_SHARED_SYSTEM, buildOutlineUserPrompt } from "./prompts";
import { makalahBudget, pickMakalahStage } from "./stages";
import type { MakalahOutline, OutlineChapter, OutlineSubsection, RefineResult, SourceSummary, TemplateConstraints } from "./types";

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
