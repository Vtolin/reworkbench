// Zero-dependency text-similarity utilities for the Makalah pipeline.
// NOTE: imports ../ingestion/dedup via RELATIVE path (not @/) so this file
// plus dedup.ts compile standalone for model-free node tests.
import { titleFuzzyScore } from "../ingestion/dedup";

/**
 * Generic function words (Indonesian + English). Content-word scoring strips
 * these before bigram comparison: template vocabulary ("yang/dan/dalam",
 * "the/of/and") otherwise pushes topically distinct academic sections to
 * ~0.76–0.84 and buries real duplication under the floor. No topic or
 * domain keywords — pure function words only.
 */
const STOPWORDS = new Set(
  (
    "yang dan di ke dari dengan untuk pada adalah merupakan sebagai serta ini itu tersebut atau juga tidak dalam oleh antara setiap semua dapat akan telah sudah lebih sangat para bahwa jika karena maupun yaitu yakni agar supaya tentang terhadap secara hingga sampai sambil sementara sedangkan namun tetapi melainkan kendatipun walaupun meskipun begitu demikian lalu kemudian maka lalu saja pun lah kah tah pun prihal " +
    "the of and to in is are was were be been being for with on at by from as that this these those it its an a or also not within between each every all can will have has had more very that if because well so then than therefore thus hence so just only no not are our your their there here when where which who whom whose what how why do does did done would could should shall may might must can will"
  )
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean),
);

/** Lowercase alphanumeric tokens, length ≥ 2 (keeps "AI", "h5", years). */
export function contentTokens(text: string): string[] {
  return ((text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/** Space-joined content words (function words removed) for similarity. */
export function contentSignature(text: string): string {
  return contentTokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .join(" ");
}

function splitParas(text: string): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);
}

/**
 * Content-word bigram similarity: max of whole-text and best paragraph pair,
 * scored on stopword-stripped signatures. Deterministic (pure function).
 */
export function sectionSimilarity(a: string, b: string): number {
  const sigA = contentSignature(a);
  const sigB = contentSignature(b);
  if (!sigA || !sigB) return 0;
  let best = titleFuzzyScore(sigA, sigB);
  const pa = splitParas(a).map(contentSignature).filter(Boolean);
  const pb = splitParas(b).map(contentSignature).filter(Boolean);
  for (const x of pa) {
    for (const y of pb) {
      const s = titleFuzzyScore(x, y);
      if (s > best) best = s;
    }
  }
  return best;
}

export interface MmrItem {
  key: string;
  /** Fused relevance score; null/NaN falls back to rank decay. */
  relevance: number | null | undefined;
  text: string;
}

/**
 * Maximal Marginal Relevance selection (deterministic):
 * score = lambda * normRelevance - (1 - lambda) * maxSimToPicked.
 * First pick is always the most relevant item. Ties break by original rank,
 * so identical inputs always yield identical selections (temperature-0 safe).
 * Similarity runs on truncated signatures for speed and stability.
 */
export function mmrSelect<T extends MmrItem>(items: T[], keepTop: number, lambda = 0.7): T[] {
  const n = items.length;
  const k = Math.min(Math.max(keepTop, 0), n);
  if (k === 0) return [];
  const relRaw = items.map((it, i) =>
    typeof it.relevance === "number" && Number.isFinite(it.relevance)
      ? (it.relevance as number)
      : 1 / (1 + i),
  );
  const maxRel = Math.max(...relRaw);
  const rel = maxRel > 0 ? relRaw.map((r) => r / maxRel) : relRaw.map(() => 0);
  const sigs = items.map((it) => contentSignature(it.text).slice(0, 240));
  const picked: number[] = [];
  const remaining = new Set(items.map((_, i) => i));
  while (picked.length < k) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of picked) {
        const s = titleFuzzyScore(sigs[i], sigs[j]);
        if (s > maxSim) maxSim = s;
      }
      const score = lambda * rel[i] - (1 - lambda) * maxSim;
      if (score > bestScore || (score === bestScore && (bestIdx === -1 || i < bestIdx))) {
        bestScore = score;
        bestIdx = i;
      }
    }
    picked.push(bestIdx);
    remaining.delete(bestIdx);
  }
  // Return in original rank order (stable, least surprise for prompts).
  return picked
    .sort((a, b) => a - b)
    .map((i) => items[i]);
}
