// Embedding core (no worker plumbing): one text slice → 768d vector.
//
// Identical policy for confirm, re-embed and reindex: local mode uses the
// on-device Ollama model, server mode uses /api/rag/embed and must return
// 768d. Throws on any failure — callers mark the document errored. Slice is
// truncated to 2000 chars, matching the confirm pipeline exactly.
import { OllamaProvider } from "@/lib/ai/ollama";

export type EmbedMode = "local" | "server";

export interface EmbeddedSlice {
  embedding: number[];
  model_name: string;
}

/** Direct (current-thread) embedding. Used as the worker fallback. */
export async function embedSliceDirect(slice: string, embedMode: EmbedMode): Promise<EmbeddedSlice> {
  const text = slice.slice(0, 2000);
  if (embedMode === "local") {
    return { embedding: await new OllamaProvider().embed(text), model_name: "nomic-embed-text" };
  }
  const res = await fetch("/api/rag/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode: "server" }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string }).error ?? "Server embedding failed (requires an OpenAI or Google key in Settings)");
  }
  const embedData = (await res.json()) as { embedding: number[]; model?: string };
  const embedding = embedData.embedding as number[];
  const embedModelName = embedData.model ?? "cloud-embedding-768d";
  // Schema is vector(768) for nomic-embed-text; a 1536d OpenAI vector
  // cannot be stored alongside. Fail loudly instead of leaving
  // chunks without embeddings that silently never match.
  if (embedding.length !== 768) {
    throw new Error(
      `Server embedding is ${embedding.length}d but the library stores 768d (nomic-embed-text). ` +
      `Upload with Embedding mode Local, or re-embed the whole library after migrating the column.`,
    );
  }
  return { embedding, model_name: embedModelName };
}
