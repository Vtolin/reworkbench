// One deterministic ingestion pass over a dropped file: extraction → hash →
// title/year/DOI/type proposal. Shared by the ingest Web Worker and the
// main-thread fallback, so both paths produce byte-identical previews.
import { sha256Hex } from "@/lib/ingestion/chunking";
import { extractDocumentText } from "@/lib/importing/docloaders";
import { analyzeText, type TextAnalysis } from "./analyze";

export interface FileAnalysis {
  fileHash: string;
  text: string;
  pageCount: number | null;
  /** Extraction threw instead of returning empty (worker/parse failure). */
  extractionError: string | null;
  analysis: TextAnalysis;
}

/**
 * Formats whose current extractor needs DOM APIs (DOMParser) and therefore
 * cannot run inside a Web Worker. They keep the main-thread extractor; their
 * hashing/analysis/chunking/embedding still run off-thread.
 */
export function canAnalyzeInWorker(file: File): boolean {
  const name = file.name.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (ext === ".docx" || ext === ".pptx") return false;
  const type = file.type;
  return (
    type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
    type !== "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

/**
 * Direct (current-thread) analysis. Extraction failures are RETURNED via
 * extractionError, exactly like previewFile always did: a silent empty text
 * would become a 0-chunk "metadata_only" row that looks like a scanned PDF.
 */
export async function analyzeFile(file: File): Promise<FileAnalysis> {
  let textOut: { text: string; pageCount: number | null } = { text: "", pageCount: null };
  let extractionError: string | null = null;
  try {
    textOut = await extractDocumentText(file);
  } catch (e) {
    extractionError = e instanceof Error ? e.message : String(e);
  }
  const buf = await file.arrayBuffer();
  const fileHash = await sha256Hex(buf);
  return {
    fileHash,
    text: textOut.text,
    pageCount: textOut.pageCount,
    extractionError,
    analysis: analyzeText(file.name, textOut.text),
  };
}
