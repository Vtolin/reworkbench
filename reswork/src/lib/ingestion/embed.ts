// Worker-aware embedding entry point. One text slice → 768d vector, with the
// network/JSON work (local Ollama or /api/rag/embed) executed in the ingest
// worker when available.
import {
  embedSliceDirect,
  type EmbeddedSlice,
  type EmbedMode,
} from "./embedCore";
import { getIngestWorkerClient, WorkerUnavailableError } from "./workerClient";

export type { EmbeddedSlice, EmbedMode };

export async function embedSlice(slice: string, embedMode: EmbedMode): Promise<EmbeddedSlice> {
  const client = getIngestWorkerClient();
  if (client) {
    try {
      const response = await client.run("embed", { text: slice, mode: embedMode });
      if (response.ok && response.kind === "embed") return response.result;
      if (!response.ok) {
        // Task-level failure (Ollama down, server key missing, dimension
        // mismatch) - retrying on the main thread repeats the same failure.
        throw new Error(response.error);
      }
      throw new Error("Ingest worker returned an unexpected result for embed");
    } catch (e) {
      if (!(e instanceof WorkerUnavailableError)) throw e;
      // Worker crashed/never loaded: fall through to the direct path.
    }
  }
  return embedSliceDirect(slice, embedMode);
}
