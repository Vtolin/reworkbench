// Browser RAG orchestrator:
//   1. Embed query (local Ollama or server cloud mode) -> Vector leg
//   2. Run server-side FTS + pgvector RPCs
//   3. Compute Okapi BM25 scoring over candidates -> BM25 leg
//   4. Fuse all 3 legs (FTS + Vector + BM25) with Reciprocal Rank Fusion (RRF)
//   5. Cross-Encoder Reranking (token interaction & proximity matching + optional LLM reranking)
//   6. Return prompt-ready context and debug diagnostics.

import { OllamaProvider } from "@/lib/ai/ollama";
import { reciprocalRankFusion, formatPassagesForPrompt, type RetrievedPassage, type FusionInput } from "./fusion";
import { bm25Rank } from "./bm25";
import { crossEncoderRerank } from "./rerank";
import type { AIProvider } from "@/lib/ai/types";
import { newTraceId, traceStep, withTrace } from "@/lib/observability/trace";

export interface RagOptions {
  workspaceId: string;
  query: string;
  topN?: number;
  embedMode: "local" | "server";
  embedModel?: string;
  /** Restrict retrieval to these documents (scoped ask / compare / synthesis). */
  scopeIds?: string[];
  onStatus?: (stage: string, detail?: string) => void;
  rerankProvider?: AIProvider;
  rerankModel?: string;
  useLlmRerank?: boolean;
  /** Client trace id (Phase 7): timings + counts only, never queries. Absent = minted. */
  traceId?: string;
}

export async function retrieveContext(opts: RagOptions): Promise<{
  passages: RetrievedPassage[];
  context: string;
  debug: {
    embedMode: "local" | "server";
    hasQueryEmbedding: boolean;
    embeddingDims: number | null;
    embedError: string | null;
    ftsCount: number;
    vectorCount: number;
    bm25Count: number;
    rerankedCount: number;
    /** Client trace id for this retrieval (Phase 7: dev/debug panel). */
    traceId: string;
  };
}> {
  const {
    workspaceId,
    query,
    topN = 8,
    embedMode,
    embedModel,
    scopeIds,
    onStatus,
    rerankProvider,
    rerankModel,
    useLlmRerank = false,
  } = opts;
  // One trace per retrieval (Phase 7): steps carry ms + counts, never queries.
  const traceId = opts.traceId ?? newTraceId("rag");

  // 1. Embed the query on the selected path. The traced closure returns its
  // outcome (rather than mutating outer lets, which defeats narrowing).
  const embedOutcome = await withTrace(
    traceId,
    "retrieve.embed",
    { provider: embedMode, counts: {} },
    async (): Promise<{ embedding: number[] | null; error: string | null }> => {
      if (embedMode === "local") {
        try {
          return { embedding: await new OllamaProvider().embed(query, { model: embedModel }), error: null };
        } catch (e) {
          return { embedding: null, error: e instanceof Error ? e.message : String(e) }; // fall back to FTS-only
        }
      }
      try {
        const res = await fetch("/api/rag/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: query, mode: "server", model: embedModel }),
        });
        if (res.ok) {
          const data = await res.json();
          const embedding = data.embedding as number[];
          if (!Array.isArray(embedding) || !embedding.length) {
            return { embedding: null, error: "Server embedding returned no vector (FTS-only)" };
          }
          return { embedding, error: null };
        }
        const errBody = await res.json().catch(() => ({}));
        return {
          embedding: null,
          error:
            (errBody as { error?: string }).error ??
            `Server embedding failed: ${res.status} (FTS-only)`,
        };
      } catch (e) {
        return { embedding: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  const queryEmbedding = embedOutcome.embedding;
  const embedError = embedOutcome.error;

  // 2. Run both legs server-side (RLS-gated RPCs).
  const fetchLimit = Math.max(topN * 3, 24);
  const data = await withTrace(traceId, "retrieve.search", { counts: { topN: fetchLimit } }, async () => {
    const res = await fetch("/api/rag/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        query,
        queryEmbedding,
        topN: fetchLimit,
      }),
    });
    if (!res.ok) throw new Error("Retrieval failed");
    return res.json();
  });

  const ftsItems = ((data.fts ?? []) as Array<RetrievedPassage & { rank: number }>);
  const vectorItems = ((data.vector ?? []) as Array<RetrievedPassage & { rank: number }>);

  // 3. Build unique candidate pool for Okapi BM25 scoring
  const candidateMap = new Map<string, RetrievedPassage>();
  for (const item of [...ftsItems, ...vectorItems]) {
    if (!candidateMap.has(item.chunk_id)) {
      candidateMap.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        document_id: item.document_id,
        content: item.content,
        chunk_index: item.chunk_index,
        page: item.page,
        section: item.section,
        score: item.score ?? 0,
        source: "fts",
      });
    }
  }

  const candidateList = Array.from(candidateMap.values());

  // 4. Compute Okapi BM25 Ranking leg (sync: time inline, no wrapper).
  const bm25T0 = Date.now();
  const bm25Docs = candidateList.map((c) => ({
    id: c.chunk_id,
    content: c.content,
    section: c.section,
    page: c.page,
  }));
  const bm25Results = bm25Rank(query, bm25Docs);
  traceStep({ traceId, step: "retrieve.bm25", ms: Date.now() - bm25T0, counts: { candidates: candidateList.length } });

  // 5. Build Fusion inputs for all 3 legs (FTS, Vector, BM25)
  const legs: FusionInput[] = [
    ...ftsItems.map((r, i) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      content: r.content,
      chunk_index: r.chunk_index,
      page: r.page,
      section: r.section,
      rank: i + 1,
      leg: "fts" as const,
    })),
    ...vectorItems.map((r, i) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      content: r.content,
      chunk_index: r.chunk_index,
      page: r.page,
      section: r.section,
      rank: i + 1,
      leg: "vector" as const,
    })),
    ...bm25Results.map((item) => {
      const c = candidateMap.get(item.id)!;
      return {
        chunk_id: c.chunk_id,
        document_id: c.document_id,
        content: c.content,
        chunk_index: c.chunk_index,
        page: c.page,
        section: c.section,
        rank: item.rank,
        leg: "bm25" as const,
      };
    }),
  ];

  // 6. Reciprocal Rank Fusion
  let fusedPassages = await withTrace(traceId, "retrieve.rrf", { counts: { legs: legs.length } }, async () =>
    reciprocalRankFusion(legs, 60, scopeIds?.length ? topN * 4 : topN * 2),
  );

  if (scopeIds?.length) {
    const scoped = fusedPassages.filter((p) => scopeIds.includes(p.document_id));
    // No silent fallback: zero in-scope hits returns []. Callers own the
    // widening policy explicitly (makalah runOne broadens to `selected`;
    // compare labels "no relevant excerpts"). Returning the unscoped fusion
    // here misattributes other docs' passages to the scoped question.
    fusedPassages = scoped;
  }

  // 7. Cross-Encoder Reranking
  onStatus?.("reranking", `Reranking top ${fusedPassages.length} candidate passages`);
  const rerankedPassages = await withTrace(
    traceId,
    "retrieve.rerank",
    { provider: rerankProvider?.id, model: rerankModel, counts: { passages: fusedPassages.length } },
    () =>
      crossEncoderRerank(query, fusedPassages, {
        topN,
        provider: rerankProvider,
        model: rerankModel,
        useLlmRerank,
        traceId,
      }),
  );

  return {
    passages: rerankedPassages,
    context: formatPassagesForPrompt(rerankedPassages),
    debug: {
      embedMode,
      hasQueryEmbedding: !!queryEmbedding,
      embeddingDims: queryEmbedding?.length ?? null,
      embedError,
      ftsCount: ftsItems.length,
      vectorCount: vectorItems.length,
      bm25Count: bm25Results.length,
      rerankedCount: rerankedPassages.length,
      traceId,
    },
  };
}
