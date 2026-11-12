// Off-main-thread ingest steps with transparent main-thread fallback.
//
// The Web Worker is an optimization, never a requirement: SSR, tests,
// locked-down browsers and worker-crash environments all keep working through
// the direct functions — same inputs, same outputs.
import { chunkTextWithPages, type ChunkInput } from "./chunking";
import { analyzeFile, canAnalyzeInWorker, type FileAnalysis } from "./fileAnalysis";
import { getIngestWorkerClient } from "./workerClient";

/**
 * Extract text + hash + title/year/DOI/type proposal off the main thread.
 * DOCX/PPTX need DOMParser (main-thread only) and go direct; PDF/XLSX/RTF/
 * plain text run in the worker. Any worker failure retries directly, so a
 * browser where pdf.js cannot run inside a worker still previews correctly.
 */
export async function analyzeFileOffThread(file: File): Promise<FileAnalysis> {
  if (!canAnalyzeInWorker(file)) return analyzeFile(file);
  const client = getIngestWorkerClient();
  if (!client) return analyzeFile(file);
  try {
    const response = await client.run("analyze", { file });
    if (response.ok && response.kind === "analyze") return response.result;
  } catch {
    // Infrastructure failure only (task failures return { ok: false } and are
    // also worth retrying here: pdf.js may need the main-thread environment).
  }
  return analyzeFile(file);
}

/** Chunk on the worker; pure deterministic work, direct fallback on failure. */
export async function chunkTextOffThread(text: string): Promise<ChunkInput[]> {
  const client = getIngestWorkerClient();
  if (!client) return chunkTextWithPages(text);
  try {
    const response = await client.run("chunk", { text });
    if (response.ok && response.kind === "chunk") return response.result;
  } catch {
    /* worker unavailable */
  }
  return chunkTextWithPages(text);
}
