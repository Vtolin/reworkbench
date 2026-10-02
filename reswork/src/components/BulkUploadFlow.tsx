"use client";
import { toUserMessage } from "@/lib/errors";
import { useState } from "react";
import { api } from "@/lib/api";
import { MAX_BULK_FILES, type BulkConfirmItem, type BulkConfirmResult, type BulkPreviewItem } from "@/lib/wb/bulkIngest";
import type { IngestRunnerEdit } from "@/lib/wb/ingestRunner";
import type { IngestPreview } from "@/lib/wb/ingest";
import type { MetadataCandidate } from "@/lib/wb/openalex";

const ACCEPT = ".pdf,.docx,.xlsx,.xls,.pptx,.rtf,.txt,.md,.csv,.tsv,.html,.htm";

// Bulk upload (up to MAX_BULK_FILES): multi-file picker → one preview pass
// per file (serial, read-only) → per-file metadata edit → one serial
// confirm pass. Single-file UploadFlow is untouched (frozen rule); this
// composes the same batch primitives the api barrel exposes.
//
// Deliberately no "Suggest from page 1" here: that is one LLM call per file
// and bulk would burn quota silently (UploadFlow keeps it manual for the
// same reason).
function buildEdit(preview: IngestPreview): IngestRunnerEdit {
  const proposal = preview.metadataProposal as MetadataCandidate | null;
  const fetched = proposal && proposal.source !== "local" ? proposal : null;
  const e = preview.extracted;
  return {
    title: fetched?.title || e.title || "",
    authors: (fetched?.authors || []).join(", "),
    year: fetched?.year ?? e.year ?? "",
    doi: fetched?.doi || e.doi || "",
    journal: fetched?.journal || "",
    jurisdiction: e.jurisdiction || "",
    document_type: fetched?.document_type || e.document_type || "",
    abstract: fetched?.abstract || "",
    volume: fetched?.volume || "",
    issue: fetched?.issue || "",
    pages: fetched?.pages || "",
    publisher: fetched?.publisher || "",
    collection_ids: preview.suggestedCollection ? [preview.suggestedCollection.id] : [],
  };
}

const inputCls = "mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white";

export default function BulkUploadFlow() {
  const [items, setItems] = useState<BulkPreviewItem[]>([]);
  const [edits, setEdits] = useState<IngestRunnerEdit[]>([]);
  const [collections, setCollections] = useState<Awaited<ReturnType<typeof api.collections>>>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quotaNote, setQuotaNote] = useState<string | null>(null);
  const [results, setResults] = useState<BulkConfirmResult[] | null>(null);

  const pick = (list: FileList | null) => {
    if (!list) return;
    const files = [...list].slice(0, MAX_BULK_FILES);
    setError(files.length < list.length ? `Only the first ${MAX_BULK_FILES} files were kept (batch cap).` : null);
    setItems(files.map((file) => ({ file, preview: null, error: null })));
    setEdits([]);
    setResults(null);
    setQuotaNote(null);
    setProgress(null);
  };

  const removeAt = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setEdits((prev) => prev.filter((_, i) => i !== idx));
    setResults(null);
  };

  const previewAll = async () => {
    if (!items.length || busy) return;
    setBusy(true);
    setError(null);
    setResults(null);
    setPhase("Previewing… extracting text, checking duplicates");
    try {
      const out = await api.previewBulk(
        items.map((i) => i.file),
        (done, total) => setProgress([done, total]),
      );
      setItems(out);
      setEdits(out.map((i) => (i.preview ? buildEdit(i.preview) : {
        title: "", authors: "", year: "", doi: "", jurisdiction: "", document_type: "",
        journal: "", volume: "", issue: "", pages: "", publisher: "", abstract: "", collection_ids: [],
      })));
      const cols = await api.collections();
      setCollections(cols);
      // Quota pre-check: the 10-files-at-once crash guard (free-tier ~1GB).
      try {
        const usage = await api.workspaceUsage();
        const batchBytes = out.reduce((sum, i) => sum + (i.file.size ?? 0), 0);
        const verdict = api.assessQuota(usage.usedBytes, batchBytes);
        setQuotaNote(
          verdict.ok
            ? null
            : `${verdict.message ?? "Over quota."}${usage.truncated ? " (usage is approximate — large library)" : ""}`,
        );
      } catch {
        setQuotaNote(null);
      }
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
      setPhase("");
      setProgress(null);
    }
  };

  const setEditAt = (idx: number, patch: Partial<IngestRunnerEdit>) => {
    setEdits((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const confirmAll = async () => {
    if (busy) return;
    const ready: BulkConfirmItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const edit = edits[i];
      if (!it || !it.preview || !edit) continue;
      ready.push({
        file: it.file,
        preview: it.preview,
        edit,
        candidate: null,
      });
    }
    if (!ready.length) {
      setError("Nothing to confirm — preview files first and drop the ones that failed.");
      return;
    }
    setBusy(true);
    setError(null);
    setPhase("Indexing… one document at a time");
    try {
      const summary = await api.confirmBulk(ready, (done, total) => setProgress([done, total]));
      setResults(summary.results);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
      setPhase("");
      setProgress(null);
    }
  };

  const previewed = items.some((i) => i.preview);
  const failedPreviews = items.filter((i) => i.error).length;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border-2 border-dashed border-[#2f2f2f] bg-[#0a0a0a] p-6 text-center">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-white text-black grid place-items-center text-xl">⇪</div>
        <div className="mt-3 font-medium text-white">Bulk upload — up to {MAX_BULK_FILES} files</div>
        <label className="mt-4 inline-flex cursor-pointer rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium hover:bg-[#ececec]">
          Choose files
          <input type="file" className="hidden" accept={ACCEPT} multiple onChange={(e) => pick(e.target.files)} />
        </label>
        {items.length > 0 && (
          <div className="mt-3 text-xs font-mono text-[#8e8e8e]">
            {items.length} file{items.length > 1 ? "s" : ""} • {(items.reduce((s, i) => s + (i.file.size ?? 0), 0) / 1024 / 1024).toFixed(2)} MB total
          </div>
        )}
        {(busy || error) && (
          <div className="mt-3">
            {busy && <div className="text-sm text-white">{phase}{progress ? ` (${progress[0]}/${progress[1]})` : ""}</div>}
            {error && <div className="rounded-xl bg-red-950/30 border border-red-900 text-red-300 p-3 text-sm break-all">{error}</div>}
          </div>
        )}
        {items.length > 0 && (
          <div className="mt-4 flex flex-col sm:flex-row gap-2 justify-center">
            <button onClick={previewAll} disabled={busy} className="rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium disabled:opacity-50 hover:bg-[#ececec]">
              {previewed ? "Re-preview all" : "Preview all"}
            </button>
            {previewed && (
              <button onClick={confirmAll} disabled={busy || !!quotaNote} className="rounded-xl border border-emerald-800 bg-emerald-950/50 text-emerald-200 px-5 py-2.5 text-sm font-medium disabled:opacity-50 hover:bg-emerald-950">
                Accept & index all
              </button>
            )}
            <button onClick={() => { setItems([]); setEdits([]); setResults(null); setQuotaNote(null); setError(null); }} disabled={busy} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2.5 text-sm text-white hover:bg-[#2f2f2f] disabled:opacity-50">
              Clear
            </button>
          </div>
        )}
        {quotaNote && <div className="mt-3 rounded-xl bg-amber-950/30 border border-amber-800 text-amber-300 p-3 text-sm">{quotaNote}</div>}
      </div>

      {items.map((it, idx) => (
        <div key={`${it.file.name}-${idx}`} className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] overflow-hidden">
          <div className="px-5 py-3 border-b border-[#2f2f2f] bg-[#171717] flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white truncate">{it.file.name}</div>
              <div className="text-xs text-[#5f5f5f]">{((it.file.size ?? 0) / 1024 / 1024).toFixed(2)} MB{it.preview ? ` • ${it.preview.pageCount ?? "?"} pages` : ""}</div>
            </div>
            {it.error && <span className="shrink-0 rounded-full px-3 py-1 text-xs border border-red-900/50 text-red-400">preview failed</span>}
            {it.preview?.isDuplicate && <span className="shrink-0 rounded-full px-3 py-1 text-xs border border-red-900/50 text-red-400">possible duplicate</span>}
            {it.preview && !it.error && <span className="shrink-0 rounded-full px-3 py-1 text-xs border border-emerald-800 text-emerald-300">ready</span>}
            <button onClick={() => removeAt(idx)} disabled={busy} className="shrink-0 rounded-lg border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e] hover:text-white disabled:opacity-50">Remove</button>
          </div>
          {it.error && <div className="px-5 py-3 text-sm text-red-300 break-all">{it.error}</div>}
          {it.preview && edits[idx] && (
            <div className="p-5 grid gap-3 md:grid-cols-2">
              <label className="md:col-span-2 text-xs font-medium text-[#ececec]">Title<input value={edits[idx]?.title ?? ""} onChange={(e) => setEditAt(idx, { title: e.target.value })} className={inputCls} /></label>
              <label className="text-xs font-medium text-[#ececec]">Authors<input value={edits[idx]?.authors ?? ""} onChange={(e) => setEditAt(idx, { authors: e.target.value })} placeholder="Comma separated" className={inputCls} /></label>
              <label className="text-xs font-medium text-[#ececec]">Journal / Venue<input value={edits[idx]?.journal ?? ""} onChange={(e) => setEditAt(idx, { journal: e.target.value })} className={inputCls} /></label>
              <label className="text-xs font-medium text-[#ececec]">Year<input value={String(edits[idx]?.year ?? "")} onChange={(e) => setEditAt(idx, { year: e.target.value })} className={inputCls} /></label>
              <label className="text-xs font-medium text-[#ececec]">Type<input value={edits[idx]?.document_type ?? ""} onChange={(e) => setEditAt(idx, { document_type: e.target.value })} className={inputCls} /></label>
              <label className="text-xs font-medium text-[#ececec]">DOI<input value={edits[idx]?.doi ?? ""} onChange={(e) => setEditAt(idx, { doi: e.target.value })} className={inputCls} /></label>
              <div className="md:col-span-2">
                <div className="text-xs font-medium text-[#ececec]">Collections</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {collections.map((c) => {
                    const on = (edits[idx]?.collection_ids || []).includes(c.id);
                    return (
                      <button key={c.id} onClick={() => setEditAt(idx, { collection_ids: on ? (edits[idx]?.collection_ids || []).filter((x: string) => x !== c.id) : [...(edits[idx]?.collection_ids || []), c.id] })} className={`rounded-full px-3 py-1.5 text-xs border flex items-center gap-1.5 ${on ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>
                        <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />{c.name}
                      </button>
                    );
                  })}
                  {collections.length === 0 && <span className="text-sm text-[#5f5f5f]">No collections — create one in the Library.</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      {failedPreviews > 0 && previewed && (
        <div className="text-xs text-[#8e8e8e]">{failedPreviews} file{failedPreviews > 1 ? "s" : ""} failed preview and will be skipped on Accept — remove or re-add them.</div>
      )}

      {results && (
        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 space-y-2">
          <div className="text-sm font-semibold text-white">Batch result — {results.filter((r) => r.document && !r.error).length}/{results.length} indexed</div>
          {results.map((r, i) => (
            <div key={i} className={`rounded-xl border px-3 py-2 text-sm ${r.error ? "border-red-900/50 bg-red-950/20 text-red-300" : "border-emerald-900/50 bg-emerald-950/20 text-emerald-200"}`}>
              <div className="truncate">{r.error ? `✗ ${r.fileName} — ${r.error}` : `✓ ${r.document?.title || r.fileName}`}</div>
              {!r.error && r.indexing_error && <div className="text-xs text-amber-300 break-all">Indexing warning: {r.indexing_error.slice(0, 300)}</div>}
              {!r.error && <div className="text-xs opacity-70">pending admin approval • {r.document?.ingestion_status}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
