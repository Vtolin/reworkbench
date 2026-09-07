// Deterministic ingestion: extraction, hashing, chunking, metadata parsing.
// No AI required — can run in the browser or a Vercel function.
// Chunk sizing preserves the existing ~4700 char / ~880 overlap starting point.

export const CHUNK_SIZE = 4700;
export const CHUNK_OVERLAP = 880;

export interface ChunkInput {
  content: string;
  chunk_index: number;
  page?: number | null;
  section?: string | null;
  pinpoint?: string | null;
}

export function chunkText(
  text: string,
  opts: { chunkSize?: number; chunkOverlap?: number } = {},
): ChunkInput[] {
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? CHUNK_OVERLAP;
  const clean = (text ?? "").replace(/\r\n/g, "\n");
  if (!clean.trim()) return [];
  const chunks: ChunkInput[] = [];
  let start = 0;
  let index = 0;
  // Prefer paragraph/sentence boundaries, fall back to hard split.
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const lastPara = window.lastIndexOf("\n\n");
      const lastSentence = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf(".\n"),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
      );
      const cut = lastPara > chunkSize * 0.4 ? lastPara : lastSentence > chunkSize * 0.4 ? lastSentence + 1 : -1;
      if (cut > 0) end = start + cut;
    }
    chunks.push({ content: clean.slice(start, end).trim(), chunk_index: index++ });
    if (end >= clean.length) break;
    start = Math.max(end - chunkOverlap, start + 1);
  }
  return chunks.filter((c) => c.content.length > 0);
}

export async function sha256Hex(input: ArrayBuffer | string): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pseudo-pagination for non-PDF formats (mirrors PSEUDO_PAGE_CHARS=3000).
export const PSEUDO_PAGE_CHARS = 3000;

export function pseudoPaginate(text: string, pageChars = PSEUDO_PAGE_CHARS): string[] {
  const pages: string[] = [];
  for (let i = 0; i < text.length; i += pageChars) {
    pages.push(text.slice(i, i + pageChars));
  }
  return pages;
}

// Browser-side PDF text extraction via pdfjs-dist (no install required).
// Returns { text, pageCount }. Callers chunk + detect sections on top.
// NOTE: the worker MUST be configured (version-pinned CDN). Without it the
// bundled build silently fails to parse in some browsers — which previously
// produced 0-chunk "metadata_only" uploads with no error shown.
export async function extractPdfTextBrowser(file: File | Blob): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  }
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: buf }).promise;
  } catch (e) {
    throw new Error(`PDF parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parts: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const str = (tc.items as Array<{ str?: string }>)
      .map((it) => it.str ?? "")
      .join(" ");
    parts.push(`[Page ${p}]\n${str}`);
  }
  return { text: parts.join("\n\n"), pageCount: pdf.numPages };
}
