// RAG over Postgres FTS + pgvector with Reciprocal Rank Fusion.
// MVP: FTS + vector + simple fusion. Reranking lands in Phase 7 (server route
// can call a cross-encoder; client keeps the fusion order until then).

export interface RetrievedPassage {
  chunk_id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  page: number | null;
  section: string | null;
  score: number;
  source: "fts" | "vector" | "fusion";
}

export interface FusionInput {
  chunk_id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  page: number | null;
  section: string | null;
  rank: number; // 1-based rank within its leg
  leg: "fts" | "vector";
}

// Reciprocal Rank Fusion: score = Σ 1/(k + rank), k=60 conventionally.
export function reciprocalRankFusion(
  legs: FusionInput[],
  k = 60,
  topN = 8,
): RetrievedPassage[] {
  const acc = new Map<string, RetrievedPassage & { _s: number; _meta: FusionInput }>();
  for (const item of legs) {
    const prev = acc.get(item.chunk_id);
    const s = 1 / (k + item.rank);
    if (prev) {
      prev._s += s;
      prev.score = prev._s;
    } else {
      acc.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        document_id: item.document_id,
        content: item.content,
        chunk_index: item.chunk_index,
        page: item.page,
        section: item.section,
        score: s,
        source: "fusion",
        _s: s,
        _meta: item,
      });
    }
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ _s, _meta, ...rest }) => rest);
}

export function formatPassagesForPrompt(passages: RetrievedPassage[]): string {
  return passages
    .map((p, i) => {
      const loc = [
        p.page ? `Page ${p.page}` : null,
        p.section ? p.section : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `[${i + 1}] (doc ${p.document_id}${loc ? `, ${loc}` : ""})\n${p.content}`;
    })
    .join("\n\n");
}
