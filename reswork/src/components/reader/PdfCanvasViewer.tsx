"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface PdfHighlightItem {
  id: string;
  page: number;
  selected_text: string;
  note?: string | null;
  color?: string | null;
}

interface PdfCanvasViewerProps {
  pdfUrl: string | null;
  page: number;
  onPageChange: (nextPage: number) => void;
  onPageCount?: (count: number) => void;
  onSelectText: (text: string, page: number) => void;
  highlights: PdfHighlightItem[];
}

type ViewMode = "canvas-text" | "canvas" | "native";

function normalizeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export default function PdfCanvasViewer({
  pdfUrl,
  page,
  onPageChange,
  onPageCount,
  onSelectText,
  highlights,
}: PdfCanvasViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [mode, setMode] = useState<ViewMode>("canvas-text");
  const [pageText, setPageText] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftPageInput, setDraftPageInput] = useState<string | null>(null);

  const pageInput = draftPageInput ?? String(page);
  const syncInput = (_p: number) => setDraftPageInput(null);

  const pdfDocRef = useRef<{
    numPages: number;
    getPage: (n: number) => Promise<{
      getViewport: (opts: { scale: number }) => { width: number; height: number };
      render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel?: () => void };
      getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
    }>;
    destroy?: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!pdfUrl) {
      pdfDocRef.current = null;
      return;
    }
    let cancelled = false;

    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoadingDoc(true);
      setLoadError(null);
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const loadingTask = pdfjs.getDocument({ url: pdfUrl, withCredentials: false });
        const doc = await loadingTask.promise;
        if (cancelled) {
          await doc.destroy?.();
          return;
        }
        pdfDocRef.current = doc as unknown as typeof pdfDocRef.current;
        setNumPages(doc.numPages);
        onPageCount?.(doc.numPages);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load PDF with PDF.js");
        }
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    })();

    return () => {
      cancelled = true;
      const doc = pdfDocRef.current;
      pdfDocRef.current = null;
      void doc?.destroy?.();
    };
  }, [pdfUrl, onPageCount]);

  useEffect(() => {
    const doc = pdfDocRef.current;
    if (!doc || numPages === 0 || mode === "native") return;

    let cancelled = false;
    let activeRenderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    const clampedPage = Math.max(1, Math.min(page, numPages));
    if (clampedPage !== page) {
      onPageChange(clampedPage);
      return;
    }

    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoadingPage(true);
      try {
        const pdfPage = await doc.getPage(clampedPage);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
            const renderViewport = pdfPage.getViewport({ scale: scale * dpr });
            canvas.width = Math.floor(renderViewport.width);
            canvas.height = Math.floor(renderViewport.height);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            activeRenderTask = pdfPage.render({
              canvasContext: ctx,
              viewport: renderViewport,
            });
            await activeRenderTask.promise;
          }
        }
        const tc = await pdfPage.getTextContent();
        if (cancelled) return;
        const text = tc.items
          .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : " "))
          .join("")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        setPageText(text);
      } catch (err) {
        if (!cancelled && !(err instanceof Error && err.name === "RenderingCancelledException")) {
          setLoadError(err instanceof Error ? err.message : "Failed to render PDF page");
        }
      } finally {
        if (!cancelled) setLoadingPage(false);
      }
    })();

    return () => {
      cancelled = true;
      activeRenderTask?.cancel?.();
    };
  }, [numPages, page, scale, mode, onPageChange]);

  const pageHighlights = useMemo(
    () => highlights.filter((h) => h.page === page),
    [highlights, page]
  );

  const renderedTextSegments = useMemo(() => {
    if (!pageText) return [];
    const snippets = pageHighlights
      .map((h) => ({ id: h.id, text: normalizeSnippet(h.selected_text), color: h.color ?? "#facc15" }))
      .filter((s) => s.text.length >= 3);
    if (snippets.length === 0) return [{ text: pageText, color: null as string | null }];

    const lower = pageText.toLowerCase();
    const first = snippets
      .map((s) => ({ ...s, idx: lower.indexOf(s.text.toLowerCase()) }))
      .filter((s) => s.idx >= 0)
      .sort((a, b) => a.idx - b.idx);

    if (first.length === 0) return [{ text: pageText, color: null as string | null }];

    const parts: Array<{ text: string; color: string | null }> = [];
    let cursor = 0;
    for (const match of first) {
      if (match.idx < cursor) continue;
      if (match.idx > cursor) parts.push({ text: pageText.slice(cursor, match.idx), color: null });
      const end = match.idx + match.text.length;
      parts.push({ text: pageText.slice(match.idx, end), color: match.color });
      cursor = end;
    }
    if (cursor < pageText.length) parts.push({ text: pageText.slice(cursor), color: null });
    return parts;
  }, [pageText, pageHighlights]);

  const commitPageJump = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed) || numPages === 0) {
      syncInput(page);
      return;
    }
    const clamped = Math.max(1, Math.min(parsed, numPages));
    syncInput(clamped);
    onPageChange(clamped);
  };

  const captureTextSelection = () => {
    const sel = typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
    if (sel) onSelectText(sel, page);
  };

  if (!pdfUrl) {
    return (
      <div className="p-10 text-sm text-[#8e8e8e]">
        No PDF file attached to this record (metadata-only / reference item).
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2f2f2f] bg-[#141414] px-3 py-2 text-xs text-[#ececec]">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={page <= 1 || numPages === 0}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 disabled:opacity-40 hover:bg-[#2f2f2f]"
          >
            Prev
          </button>
          <span className="text-[#8e8e8e]">Page</span>
          <input
            aria-label="Current page number"
            value={pageInput}
            onChange={(e) => setDraftPageInput(e.target.value)}
            onBlur={commitPageJump}
            onKeyDown={(e) => e.key === "Enter" && commitPageJump()}
            className="w-14 rounded-lg border border-[#2f2f2f] bg-black px-2 py-1 text-center text-white"
          />
          <span className="text-[#8e8e8e]">/ {numPages || "?"}</span>
          <button
            type="button"
            disabled={numPages === 0 || page >= numPages}
            onClick={() => onPageChange(Math.min(numPages, page + 1))}
            className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 disabled:opacity-40 hover:bg-[#2f2f2f]"
          >
            Next
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.75, Number((s - 0.25).toFixed(2))))}
            className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-2 py-1 hover:bg-[#2f2f2f]"
          >
            −
          </button>
          <span className="w-12 text-center text-[#8e8e8e]">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(2.25, Number((s + 0.25).toFixed(2))))}
            className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-2 py-1 hover:bg-[#2f2f2f]"
          >
            +
          </button>
          <select
            aria-label="Viewer mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ViewMode)}
            className="ml-2 rounded-lg border border-[#2f2f2f] bg-black px-2 py-1 text-white"
          >
            <option value="canvas-text">Canvas + Selectable text</option>
            <option value="canvas">Canvas only</option>
            <option value="native">Native browser PDF</option>
          </select>
        </div>
      </div>

      {loadError && mode !== "native" && (
        <div className="border-b border-[#451a1a] bg-[#261212] px-4 py-2 text-xs text-[#fca5a5] flex items-center justify-between gap-2">
          <span>PDF.js could not render cleanly ({loadError}). Switch to native fallback if needed.</span>
          <button
            type="button"
            onClick={() => setMode("native")}
            className="rounded-lg border border-[#7f1d1d] px-2.5 py-1 text-white hover:bg-[#7f1d1d]/30"
          >
            Use Native PDF
          </button>
        </div>
      )}

      {mode === "native" ? (
        <iframe src={`${pdfUrl}#page=${page}`} className="w-full" style={{ height: "70vh" }} title="PDF reader" />
      ) : (
        <div className={`grid gap-0 ${mode === "canvas-text" ? "lg:grid-cols-12" : ""}`}>
          <div
            className={`overflow-auto bg-[#111111] p-4 flex justify-center ${
              mode === "canvas-text" ? "lg:col-span-7 border-b lg:border-b-0 lg:border-r border-[#2f2f2f]" : ""
            }`}
            style={{ maxHeight: "72vh" }}
          >
            <div className="relative">
              {(loadingDoc || loadingPage) && (
                <div className="mb-2 text-xs text-[#8e8e8e]">Rendering page {page}…</div>
              )}
              <canvas ref={canvasRef} className="rounded-lg shadow-lg bg-white max-w-full h-auto" />
            </div>
          </div>

          {mode === "canvas-text" && (
            <div className="lg:col-span-5 flex flex-col bg-[#0a0a0a]" style={{ maxHeight: "72vh" }}>
              <div className="border-b border-[#2f2f2f] px-3 py-2 flex items-center justify-between text-xs text-[#8e8e8e]">
                <span>Selectable text - page {page}</span>
                <span>{pageHighlights.length} highlight{pageHighlights.length === 1 ? "" : "s"} on page</span>
              </div>
              <div
                onMouseUp={captureTextSelection}
                className="flex-1 overflow-auto p-3 text-xs leading-6 text-[#e5e5e5] whitespace-pre-wrap select-text cursor-text"
              >
                {pageText ? (
                  renderedTextSegments.map((seg, i) =>
                    seg.color ? (
                      <mark
                        key={i}
                        style={{ backgroundColor: `${seg.color}40`, color: "#ffffff" }}
                        className="rounded px-0.5 border-b border-current"
                      >
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    )
                  )
                ) : (
                  <span className="text-[#8e8e8e]">
                    {loadingDoc || loadingPage
                      ? "Extracting text from page…"
                      : "No selectable text found on this page (it may be a scanned image)."}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
