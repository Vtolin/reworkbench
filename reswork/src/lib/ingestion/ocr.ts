import { OLLAMA_BASE_URL } from "@/lib/ai/ollama";

export const MAX_OCR_PAGES = 10;

export interface OcrOptions {
  mode: "local" | "cloud";
  model: string;
  cloudProvider?: string;
  apiKey?: string;
  maxPages?: number;
  onProgress?: (page: number, total: number) => void;
}

const OCR_PROMPT =
  "Transcribe all visible text on this scanned document page verbatim. Preserve headings and paragraph breaks. Do not add commentary.";

export function formatOcrPagesText(pages: Array<{ page: number; text: string }>): string {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => `[Page ${p.page}]\n${p.text.trim()}`)
    .join("\n\n");
}

export async function ocrSinglePageImage(
  base64Jpeg: string,
  pageNum: number,
  opts: Pick<OcrOptions, "mode" | "model" | "cloudProvider" | "apiKey">,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const model = opts.model.trim();
  if (!model) {
    throw new Error("A vision-capable model name is required for OCR");
  }

  if (opts.mode === "local") {
    const res = await fetchImpl(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: `${OCR_PROMPT} (Page ${pageNum})`,
            images: [base64Jpeg],
          },
        ],
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Local Ollama OCR failed on page ${pageNum} (${res.status}): ${msg.slice(0, 180)}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() ?? "";
  }

  const res = await fetchImpl("/api/ai/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: opts.cloudProvider || "openai",
      model,
      ...(opts.apiKey?.trim() ? { apiKey: opts.apiKey.trim() } : {}),
      maxTokens: 2048,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${OCR_PROMPT} (Page ${pageNum})` },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errBody?.error || `Cloud Vision OCR failed on page ${pageNum} (${res.status})`);
  }
  const data = (await res.json()) as { content?: string };
  return typeof data.content === "string" ? data.content.trim() : "";
}

export async function extractScannedPdfOcr(
  file: File,
  opts: OcrOptions
): Promise<{ text: string; pagesProcessed: number }> {
  if (typeof document === "undefined") {
    throw new Error("Scanned PDF rasterization requires a browser canvas");
  }

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const bytes = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const total = Math.max(0, Math.min(doc.numPages, opts.maxPages ?? MAX_OCR_PAGES, MAX_OCR_PAGES));

  const pageResults: Array<{ page: number; text: string }> = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    await doc.destroy?.();
    throw new Error("Canvas 2D context unavailable for PDF OCR");
  }

  try {
    for (let p = 1; p <= total; p++) {
      opts.onProgress?.(p, total);
      const pdfPage = await doc.getPage(p);
      const viewport = pdfPage.getViewport({ scale: 1.35 });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      const base64Jpeg = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
      const pageText = await ocrSinglePageImage(base64Jpeg, p, opts);
      if (pageText) {
        pageResults.push({ page: p, text: pageText });
      }
    }
  } finally {
    await doc.destroy?.();
  }

  return {
    text: formatOcrPagesText(pageResults),
    pagesProcessed: total,
  };
}
