// Browser RAG orchestrator: embed query (local Ollama or server cloud mode),
// call both retrieval legs, fuse with RRF, return prompt-ready context.
// The browser owns this coordination; Vercel never touches localhost.
import { OllamaProvider } from "@/lib/ai/ollama";
import { reciprocalRankFusion, type RetrievedPassage } from "./fusion";

export interface RagOptions {
  workspaceId: string;
  query: string;
  topN?: number;
  embedMode: "local" | "server";
  embedModel?: string;
  /** Restrict retrieval to these documents (scoped ask / compare / synthesis). */
  scopeIds?: string[];
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
  };
}> {
  const { workspaceId, query, topN = 8, embedMode, embedModel, scopeIds } = opts;

  // 1. Embed the query on the selected path.
  // NOTE: failures here used to be silent (FTS-only fallback with no signal),
  // which made cloud+local-embed misses undebuggable. Capture the reason.
  let queryEmbedding: number[] | null = null;
  let embedError: string | null = null;
  if (embedMode === "local") {
    try {
      queryEmbedding = await new OllamaProvider().embed(query, { model: embedModel });
    } catch (e) {
      queryEmbedding = null; // fall back to FTS-only
      embedError = e instanceof Error ? e.message : String(e);
    }
  } else {
    try {
      const res = await fetch("/api/rag/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: query, mode: "server", model: embedModel }),
      });
      if (res.ok) {
        const data = await res.json();
        queryEmbedding = data.embedding as number[];
        if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) {
          embedError = "Server embedding returned no vector (FTS-only)";
          queryEmbedding = null;
        }
      } else {
        const errBody = await res.json().catch(() => ({}));
        embedError =
          (errBody as { error?: string }).error ??
          `Server embedding failed: ${res.status} (FTS-only)`;
      }
    } catch (e) {
      embedError = e instanceof Error ? e.message : String(e);
    }
  }

  // 2. Run both legs server-side (RLS-gated RPCs).
  const res = await fetch("/api/rag/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      query,
      queryEmbedding,
      topN: Math.max(topN, 20),
    }),
  });
  if (!res.ok) throw new Error("Retrieval failed");
  const data = await res.json();

  // 3. Fuse in the browser (deterministic, no AI).
  const legs = [
    ...((data.fts ?? []) as Array<RetrievedPassage & { rank: number }>).map((r, i) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      content: r.content,
      chunk_index: r.chunk_index,
      page: r.page,
      section: r.section,
      rank: i + 1,
      leg: "fts" as const,
    })),
    ...((data.vector ?? []) as Array<RetrievedPassage & { rank: number }>).map((r, i) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      content: r.content,
      chunk_index: r.chunk_index,
      page: r.page,
      section: r.section,
      rank: i + 1,
      leg: "vector" as const,
    })),
  ];
  const { formatPassagesForPrompt } = await import("./fusion");
  let passages = reciprocalRankFusion(legs, 60, scopeIds?.length ? topN * 3 : topN);
  if (scopeIds?.length) {
    // Scoped ask: keep only passages from the selected documents.
    const scoped = passages.filter((p) => scopeIds.includes(p.document_id));
    passages = (scoped.length ? scoped : passages).slice(0, topN);
  }
  return {
    passages,
    context: formatPassagesForPrompt(passages),
    debug: {
      embedMode,
      hasQueryEmbedding: !!queryEmbedding,
      embeddingDims: queryEmbedding?.length ?? null,
      embedError,
      ftsCount: (data.fts ?? []).length,
      vectorCount: (data.vector ?? []).length,
    },
  };
}
