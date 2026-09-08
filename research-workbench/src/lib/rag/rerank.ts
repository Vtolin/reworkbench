// Cross-Encoder Reranking Engine.
// Evaluates full cross-token interactions between Query and Passages:
//   1. Query Coverage: Penalizes passages missing key query concepts.
//   2. Minimal Span Proximity: Rewards passages where query terms appear clustered together.
//   3. Contiguous N-Gram Alignment: Captures exact phrase semantics without bi-encoder vector dilution.
//   4. Title & Section Cross-Matching: Boosts passages under directly relevant headings.
//   5. Optional LLM Zero-Shot Reranking: High-precision neural rerank via the user's active inference model.

import { tokenize } from "./bm25";
import type { RetrievedPassage } from "./fusion";
import type { AIProvider } from "@/lib/ai/types";

export interface RerankOptions {
  topN?: number;
  provider?: AIProvider | null;
  model?: string;
  useLlmRerank?: boolean;
}

/**
 * Computes the minimum token window span containing all matching query terms in the passage.
 * Returns a proximity factor in [0, 1]. Clustered terms -> ~1.0; scattered terms -> < 0.2.
 */
function computeTermProximity(queryTerms: string[], passageTokens: string[]): number {
  if (queryTerms.length <= 1 || passageTokens.length === 0) return 1.0;

  // Find position indices for each query term in passageTokens
  const termPositions: number[][] = [];
  for (const q of queryTerms) {
    const pos: number[] = [];
    for (let i = 0; i < passageTokens.length; i++) {
      if (passageTokens[i] === q) pos.push(i);
    }
    if (pos.length > 0) termPositions.push(pos);
  }

  // If fewer than 2 distinct query terms found, no proximity to compute
  if (termPositions.length < 2) return 0.5;

  // Find minimum window spanning at least one position of each found term
  let minSpan = Infinity;
  const indices = new Array(termPositions.length).fill(0);

  while (true) {
    let minVal = Infinity;
    let maxVal = -Infinity;
    let minTermIdx = -1;

    for (let i = 0; i < termPositions.length; i++) {
      const val = termPositions[i][indices[i]];
      if (val < minVal) {
        minVal = val;
        minTermIdx = i;
      }
      if (val > maxVal) {
        maxVal = val;
      }
    }

    const span = maxVal - minVal + 1;
    if (span < minSpan) minSpan = span;

    // Advance the pointer at minVal
    if (indices[minTermIdx] + 1 < termPositions[minTermIdx].length) {
      indices[minTermIdx]++;
    } else {
      break;
    }
  }

  // Convert span to proximity score:
  // Theoretical minimum span is termPositions.length
  const idealSpan = termPositions.length;
  // Exponential decay as span widens: e.g. span within 25 tokens remains very high
  const diff = Math.max(0, minSpan - idealSpan);
  return Math.exp(-diff / 25.0);
}

/**
 * Cross-encoder interaction scoring for a single (query, passage) pair.
 */
export function scoreCrossInteraction(query: string, passage: RetrievedPassage): number {
  const queryTokens = tokenize(query, true);
  const effectiveQueryTokens = queryTokens.length > 0 ? queryTokens : tokenize(query, false);
  if (effectiveQueryTokens.length === 0) return passage.score;

  const passageText = passage.content.toLowerCase();
  const passageTokens = tokenize(passage.content, false);

  // 1. Query Coverage: how many distinct query terms are present in the passage
  const matchedTerms = effectiveQueryTokens.filter((t) => passageText.includes(t));
  const coverageRatio = matchedTerms.length / effectiveQueryTokens.length;

  // Strong penalty if coverage is low (e.g. query asked for 4 things, passage only had 1)
  const coverageScore = Math.pow(coverageRatio, 1.5);

  // 2. Term Proximity
  const proximityScore = computeTermProximity(effectiveQueryTokens, passageTokens);

  // 3. Exact Phrase and N-gram Matching
  const queryNormalized = query.toLowerCase().trim();
  let ngramBonus = 0;
  if (queryNormalized.length > 3 && passageText.includes(queryNormalized)) {
    ngramBonus += 0.4;
  } else {
    // Check 2-gram and 3-gram contiguous matches
    const words = queryNormalized.split(/\s+/);
    if (words.length >= 3) {
      for (let i = 0; i < words.length - 1; i++) {
        const bigram = `${words[i]} ${words[i + 1]}`;
        if (passageText.includes(bigram)) ngramBonus += 0.1;
        if (i < words.length - 2) {
          const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
          if (passageText.includes(trigram)) ngramBonus += 0.15;
        }
      }
    }
  }

  // 4. Section Heading Relevance Boost
  let sectionBoost = 0;
  if (passage.section) {
    const secLower = passage.section.toLowerCase();
    const secMatches = effectiveQueryTokens.filter((t) => secLower.includes(t)).length;
    if (secMatches > 0) {
      sectionBoost = (secMatches / effectiveQueryTokens.length) * 0.25;
    }
  }

  // 5. Combine into cross-encoder relevance score (scale ~0 to 2.0)
  const crossScore =
    coverageScore * 0.5 +
    proximityScore * 0.25 +
    ngramBonus * 0.3 +
    sectionBoost +
    (passage.score || 0) * 0.1; // maintain slight base rank prior

  return crossScore;
}

/**
 * Fast cross-encoder reranker.
 * Re-scores candidate passages and sorts them by deep cross-token relevance.
 */
export function fastCrossEncoderRerank(
  query: string,
  passages: RetrievedPassage[],
  topN = 8
): RetrievedPassage[] {
  if (passages.length <= 1) return passages.slice(0, topN);

  const scored = passages.map((p) => {
    const crossScore = scoreCrossInteraction(query, p);
    return {
      ...p,
      score: crossScore,
      source: "fusion" as const, // preserved or upgraded
    };
  });

  // Sort descending by cross-encoder score
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topN);
}

/**
 * Optional LLM-based Listwise Cross-Encoder Reranker.
 * When the user has a fast model or explicitly enables LLM reranking,
 * asks the model to output the optimal ordering of passages based on direct query answering capability.
 */
export async function llmCrossEncoderRerank(
  query: string,
  passages: RetrievedPassage[],
  provider: AIProvider,
  model: string,
  topN = 8
): Promise<RetrievedPassage[]> {
  if (passages.length <= 1) return passages.slice(0, topN);

  const candidates = passages.slice(0, Math.min(passages.length, 16));
  const promptLines = candidates.map((p, idx) => {
    const preview = p.content.slice(0, 300).replace(/\s+/g, " ");
    return `[${idx + 1}] (Page ${p.page ?? "?"} | ${p.section || "General"}): ${preview}`;
  });

  const prompt =
    `You are a strict relevance ranker for academic retrieval.\n` +
    `Query: "${query}"\n\n` +
    `Candidate Passages:\n${promptLines.join("\n")}\n\n` +
    `Rank the candidates by direct relevance to answering the query. ` +
    `Return ONLY a JSON array of the top passage numbers in order of relevance (e.g. [3, 1, 5, 2]). ` +
    `Do not include any prose or explanation.`;

  try {
    const res = await provider.chat(
      [{ role: "user", content: prompt }],
      { model, temperature: 0.0, numPredict: 128 }
    );
    const match = res.content.match(/\[[\d,\s]+\]/);
    if (!match) return fastCrossEncoderRerank(query, passages, topN);

    const rankedIndices = JSON.parse(match[0]) as number[];
    const reordered: RetrievedPassage[] = [];
    const seen = new Set<number>();

    for (const num of rankedIndices) {
      const idx = num - 1;
      if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        seen.add(idx);
        reordered.push({ ...candidates[idx], source: "fusion" });
      }
    }

    // Append any unranked candidates
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) reordered.push(candidates[i]);
    }

    return reordered.slice(0, topN);
  } catch {
    // Fall back to fast cross-encoder on any failure
    return fastCrossEncoderRerank(query, passages, topN);
  }
}

/**
 * Master Cross-Encoder Rerank Function.
 * Applies fast cross-interaction scoring, and optionally LLM reranking if configured.
 */
export async function crossEncoderRerank(
  query: string,
  passages: RetrievedPassage[],
  opts: RerankOptions = {}
): Promise<RetrievedPassage[]> {
  const { topN = 8, provider, model, useLlmRerank = false } = opts;
  if (!passages || passages.length <= 1) return passages ? passages.slice(0, topN) : [];

  if (useLlmRerank && provider && model) {
    return llmCrossEncoderRerank(query, passages, provider, model, topN);
  }

  return fastCrossEncoderRerank(query, passages, topN);
}
