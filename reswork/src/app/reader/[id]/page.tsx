"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import PdfCanvasViewer, { type PdfHighlightItem } from "@/components/reader/PdfCanvasViewer";
import { api } from "@/lib/api";

type DocRecord = Awaited<ReturnType<typeof api.getDocument>>;
type AskResponse = Awaited<ReturnType<typeof api.ask>>;

interface ReaderHighlight extends PdfHighlightItem {
  category: string;
  created_at: string;
}

function toReaderHighlight(r: Record<string, unknown>): ReaderHighlight {
  return {
    id: String(r.id ?? ""),
    page: typeof r.page === "number" && r.page >= 1 ? r.page : 1,
    selected_text: String(r.selected_text ?? ""),
    note: typeof r.note === "string" ? r.note : null,
    color: typeof r.color === "string" ? r.color : "#facc15",
    category: String(r.category ?? "highlight"),
    created_at: String(r.created_at ?? ""),
  };
}

function ReaderContent() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const initialPageRaw = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const [doc, setDoc] = useState<DocRecord | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(
    Number.isFinite(initialPageRaw) && initialPageRaw >= 1 ? initialPageRaw : 1
  );
  const [pageCount, setPageCount] = useState<number>(0);
  const [selection, setSelection] = useState("");
  const [selectionPage, setSelectionPage] = useState(currentPage);
  const [note, setNote] = useState("");
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [saving, setSaving] = useState(false);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<{ prompt: string; answer: string; sources: AskResponse["sources"] } | null>(null);

  const reloadAnnotations = useCallback(async () => {
    if (!id) return;
    try {
      const rows = await api.annotations(String(id));
      setHighlights(rows.map(toReaderHighlight));
    } catch {
      // Leave existing list intact on transient error
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    api
      .getDocument(String(id))
      .then(async (d) => {
        setDoc(d);
        try {
          setPdfUrl(await api.documentFileUrl(d));
        } catch {
          setPdfUrl(null);
        }
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    api
      .annotations(String(id))
      .then((rows) => {
        if (active) setHighlights(rows.map(toReaderHighlight));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);

  const handlePageChange = useCallback((nextPage: number) => {
    setCurrentPage(nextPage);
    setSelectionPage((prev) => (selection.trim() ? prev : nextPage));
  }, [selection]);

  const handleSelectText = useCallback((text: string, pg: number) => {
    setSelection(text);
    setSelectionPage(pg);
  }, []);

  const addHighlight = async (color = "#facc15") => {
    if (!selection.trim() || !id || saving) return;
    setSaving(true);
    try {
      await api.createAnnotation(String(id), {
        page: selectionPage || currentPage,
        selected_text: selection.trim(),
        note: note.trim() || undefined,
        color,
      });
      setSelection("");
      setNote("");
      await reloadAnnotations();
    } finally {
      setSaving(false);
    }
  };

  const askAbout = async (text: string) => {
    if (!text.trim() || !id || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const r = await api.ask({
        query: `Explain in the context of this document (p. ${selectionPage || currentPage}): "${text.trim()}"`,
        document_ids: [String(id)],
      });
      setAskResult({
        prompt: text.trim().slice(0, 140),
        answer: r.answer,
        sources: r.sources ?? [],
      });
    } catch (err) {
      setAskError(err instanceof Error ? err.message : "Failed to query AI about selection");
    } finally {
      setAskBusy(false);
    }
  };

  const handleDeleteAnnotation = async (annotationId: string) => {
    if (!id || busyDeleteId) return;
    setBusyDeleteId(annotationId);
    try {
      await api.deleteAnnotation(String(id), annotationId);
      setHighlights((prev) => prev.filter((item) => item.id !== annotationId));
    } finally {
      setBusyDeleteId(null);
    }
  };

  if (!doc) return <div className="p-6 text-sm text-[#8e8e8e] bg-black min-h-screen">Loading…</div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar
        title={doc.title}
        subtitle={`${doc.original_filename || "Reference record"} • ${pageCount || doc.page_count || "?"} pages - p. ${currentPage}`}
      />
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        <div className="flex-1 bg-black p-4 overflow-auto">
          <div className="mx-auto max-w-5xl bg-[#0a0a0a] rounded-2xl border border-[#2f2f2f] overflow-hidden">
            <PdfCanvasViewer
              pdfUrl={pdfUrl}
              page={currentPage}
              onPageChange={handlePageChange}
              onPageCount={setPageCount}
              onSelectText={handleSelectText}
              highlights={highlights}
            />
          </div>

          <div className="mx-auto max-w-5xl mt-4 rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-white">Selection & annotation (p. {selectionPage || currentPage})</div>
              <label className="text-xs text-[#8e8e8e] flex items-center gap-1.5">
                Page
                <input
                  type="number"
                  min={1}
                  max={pageCount || undefined}
                  value={selectionPage}
                  onChange={(e) => setSelectionPage(Math.max(1, Number.parseInt(e.target.value || "1", 10) || 1))}
                  className="w-16 rounded-lg border border-[#2f2f2f] bg-[#171717] px-2 py-1 text-xs text-white"
                />
              </label>
            </div>
            <textarea
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
              placeholder="Drag-select text in the page text panel above, or paste a passage here…"
              rows={3}
              className="mt-2 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note attached to highlight (optional)"
              className="mt-2 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button disabled={saving || !selection.trim()} onClick={() => addHighlight("#facc15")} className="rounded-xl bg-[#facc15] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">Highlight yellow</button>
              <button disabled={saving || !selection.trim()} onClick={() => addHighlight("#86efac")} className="rounded-xl bg-[#86efac] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">Highlight green</button>
              <button disabled={saving || !selection.trim()} onClick={() => addHighlight("#93c5fd")} className="rounded-xl bg-[#93c5fd] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">Highlight blue</button>
              <button disabled={askBusy || !selection.trim()} onClick={() => askAbout(selection)} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-40">
                {askBusy ? "Asking AI…" : "Ask AI about selection"}
              </button>
            </div>

            {askError && (
              <div className="mt-3 rounded-xl border border-[#7f1d1d] bg-[#261212] p-3 text-xs text-[#fca5a5]">{askError}</div>
            )}

            {askResult && (
              <div className="mt-3 rounded-xl border border-[#2f2f2f] bg-[#141414] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-white">AI Explanation: “{askResult.prompt}”</div>
                  <button type="button" onClick={() => setAskResult(null)} className="text-xs text-[#8e8e8e] hover:text-white">Dismiss</button>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-[#e5e5e5] leading-6">{askResult.answer}</div>
                {askResult.sources.filter((s) => s.page != null).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {askResult.sources
                      .filter((s): s is typeof s & { page: number } => typeof s.page === "number")
                      .slice(0, 6)
                      .map((s, idx) => (
                        <button
                          key={`${s.page}-${idx}`}
                          type="button"
                          onClick={() => setCurrentPage(Math.max(1, s.page))}
                          className="rounded-full border border-[#2f2f2f] bg-[#212121] px-2.5 py-0.5 text-[11px] text-[#d4d4d4] hover:text-white"
                        >
                          Jump p. {s.page}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="w-full lg:w-[360px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#2f2f2f] bg-[#0a0a0a] flex flex-col max-h-[50vh] lg:max-h-none">
          <div className="p-4 border-b border-[#2f2f2f]">
            <div className="text-sm font-semibold text-white">Highlights & notes</div>
            <div className="text-xs text-[#8e8e8e] break-words">{highlights.length} highlights - click a page badge to jump</div>
          </div>
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {highlights.map((h) => (
              <div key={h.id} className="rounded-xl border p-3" style={{ background: `${h.color || "#facc15"}20`, borderColor: "#2f2f2f" }}>
                <div className="flex items-center justify-between gap-2 text-xs text-[#8e8e8e]">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(Math.max(1, h.page))}
                    className="rounded-md border border-[#2f2f2f] bg-black/70 px-1.5 py-0.5 text-white hover:bg-black"
                  >
                    p. {h.page}
                  </button>
                  <span>{new Date(h.created_at).toLocaleDateString()}</span>
                </div>
                <div className="text-sm mt-1.5 text-white break-words">“{h.selected_text}”</div>
                {Boolean(h.note) && (
                  <div className="text-sm mt-1.5 text-[#ececec] bg-black rounded-lg px-2 py-1 border border-[#2f2f2f] break-words">
                    {h.note}
                  </div>
                )}
                <div className="mt-2 flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={askBusy}
                    onClick={() => void askAbout(h.selected_text)}
                    className="text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 text-white hover:bg-[#2f2f2f]"
                  >
                    Ask AI
                  </button>
                  <button
                    type="button"
                    disabled={busyDeleteId === h.id}
                    onClick={() => void handleDeleteAnnotation(h.id)}
                    className="text-xs rounded-full border border-[#451a1a] bg-[#211111] px-2.5 py-1 text-[#fca5a5] hover:bg-[#3f1616] disabled:opacity-40"
                  >
                    {busyDeleteId === h.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
            {highlights.length === 0 && (
              <div className="text-sm text-[#8e8e8e]">No highlights yet. Select text on a page and highlight it.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-[#8e8e8e] bg-black min-h-screen">Loading reader…</div>}>
      <ReaderContent />
    </Suspense>
  );
}
