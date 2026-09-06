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
}

export async function retrieveContext(opts: RagOptions): Promise<{
  passages: RetrievedPassage[];
  context: string;
}> {
  const { workspaceId, query, topN = 8, embedMode, embedModel } = opts;

  // 1. Embed the query on the selected path.
  let queryEmbedding: number[] | null = null;
  if (embedMode === "local") {
    try {
      queryEmbedding = await new OllamaProvider().embed(query, { model: embedModel });
    } catch {
      queryEmbedding = null; // fall back to FTS-only
    }
  } else {
    const res = await fetch("/api/rag/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: query, mode: "server", model: embedModel }),
    });
    if (res.ok) {
      const data = await res.json();
      queryEmbedding = data.embedding as number[];
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
  const passages = reciprocalRankFusion(legs, 60, topN);
  return { passages, context: formatPassagesForPrompt(passages) };
}
