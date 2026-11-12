// Ingest worker task dispatcher. Kept separate from the worker entry so tests
// can exercise the exact code the worker runs without a Worker global.
import { chunkTextWithPages } from "./chunking";
import { embedSliceDirect } from "./embedCore";
import { analyzeFile } from "./fileAnalysis";
import type { IngestWorkerRequest, IngestWorkerResponse } from "./workerProtocol";

export async function runIngestTask(req: IngestWorkerRequest): Promise<IngestWorkerResponse> {
  try {
    return await dispatch(req);
  } catch (e) {
    return {
      id: req.id,
      kind: req.kind,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function dispatch(req: IngestWorkerRequest): Promise<IngestWorkerResponse> {
  switch (req.kind) {
    case "analyze":
      return { id: req.id, kind: "analyze", ok: true, result: await analyzeFile(req.payload.file) };
    case "chunk":
      return { id: req.id, kind: "chunk", ok: true, result: chunkTextWithPages(req.payload.text) };
    case "embed":
      return {
        id: req.id,
        kind: "embed",
        ok: true,
        result: await embedSliceDirect(req.payload.text, req.payload.mode),
      };
  }
  throw new Error(`Unknown ingest task: ${(req as { kind?: string }).kind ?? "?"}`);
}
