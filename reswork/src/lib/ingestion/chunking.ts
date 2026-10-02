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
): ChunkInput[] {  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? CHUNK_OVERLAP;
  const clean = (text ?? "").replace(/\r\n/g, "\n");
  if (!clean.trim()) return [];
  const chunks: ChunkInput[] = [];
  let start = 0;
  let index = 0;
  // Prefer paragraph/sentence boundaries, fall back to hard split.
  // CJK sentence ends (。！？) included — latin-only boundaries hard-split
  // spaceless text mid-sentence at 4700 chars.
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
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf("\n"),
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

/**
 * Page-aware chunking for PDF-extracted text. The browser PDF extractor
 * prefixes every page with a "[Page N]" marker; this splits on those markers
 * so each chunk carries its real `page` (powering "h. X" pinpoint citations),
 * and strips the markers from stored content (they otherwise pollute
 * embeddings, FTS/BM25 text, and leak into prompts as fake citation keys).
 * Texts without markers (Word/Excel/sheets/plain) behave exactly like
 * chunkText — page stays null.
 */
export function chunkTextWithPages(
  text: string,
  opts: { chunkSize?: number; chunkOverlap?: number } = {},
): ChunkInput[] {
  const clean = (text ?? "").replace(/\r\n/g, "\n");
  if (!clean.trim()) return [];
  const parts = clean.split(/\[Page (\d+)\]\n?/);
  // No markers → identical to chunkText.
  if (parts.length < 3) return chunkText(text, opts);
  const out: ChunkInput[] = [];
  let index = 0;
  // parts[0] is pre-marker lead text (usually empty); then (page, body) pairs.
  if (parts[0].trim()) {
    for (const c of chunkText(parts[0], opts)) out.push({ ...c, chunk_index: index++ });
  }
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const page = Number(parts[i]);
    const body = parts[i + 1];
    if (!body || !body.trim()) continue;
    for (const c of chunkText(body, opts)) {
      out.push({
        ...c,
        chunk_index: index++,
        page: Number.isInteger(page) ? page : null,
      });
    }
  }
  return out.filter((c) => c.content.length > 0);
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
    // Preserve line breaks via hasEOL: joining everything with spaces
    // fuses title/author/affiliation lines into one blob, which breaks
    // downstream title detection (and degrades chunk boundaries).
    let str = "";
    for (const it of (tc.items as Array<{ str?: string; hasEOL?: boolean }>)) {
      str += (it.str ?? "");
      str += it.hasEOL ? "\n" : " ";
    }
    parts.push(`[Page ${p}]\n${str.trim()}`);
  }
  return { text: parts.join("\n\n"), pageCount: pdf.numPages };
}
