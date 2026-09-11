"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useInference } from "@/contexts/InferenceContext";
import {
  previewFile, confirmIngest,
  buildTitleAssistPrompt, parseTitleAssistJson, pageOneText,
  type IngestPreview,
} from "@/lib/wb/ingest";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import { cleanDoi } from "@/lib/wb/openalex";

function buildEdit(candidate: any, preview: IngestPreview | null) {
  const e = preview?.extracted || {};
  return {
    title: candidate?.title || (e as any).title || "",
    authors: (candidate?.authors || []).join(", "),
    year: candidate?.year ?? (e as any).year ?? "",
    doi: candidate?.doi || (e as any).doi || "",
    jurisdiction: (e as any).jurisdiction || "",
    document_type: candidate?.document_type || (e as any).document_type || "",
    journal: candidate?.journal || "",
    volume: candidate?.volume || "",
    issue: candidate?.issue || "",
    pages: candidate?.pages || "",
    publisher: candidate?.publisher || "",
    abstract: candidate?.abstract || "",
    collection_ids: preview?.suggestedCollection ? [preview.suggestedCollection.id] : [],
  };
}

export default function UploadFlow({ onDone }: { onDone?: ()=>void }) {
  const { settings } = useInference();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState("");
  const [edit, setEdit] = useState<any>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [activeCandidate, setActiveCandidate] = useState<any>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const startPreview = async (f: File) => {
    setFile(f); setError(null); setPreview(null); setResult(null);
    setAiError(null);
    setLoading(true); setPhase("Analyzing… extracting text, checking OpenAlex, duplicates, classifying");
    try {
      const r = await previewFile(f);
      setPreview(r);
      setCandidates(r.metadataCandidates || []);
      const fetched = r.metadataProposal && r.metadataProposal.source !== "local"
        ? r.metadataProposal : null;
      setActiveCandidate(fetched);
      setEdit(buildEdit(fetched, r));
      const cols = await api.collections();
      setCollections(cols);
    } catch(e:any){ setError(e.message); }
    finally{ setLoading(false); setPhase(""); }
  };

  const rejectProposal = () => {
    setActiveCandidate(null);
    setEdit(buildEdit(null, preview));
  };

  const chooseCandidate = (idx: string) => {
    const c = idx === "" ? null : candidates[Number(idx)];
    setActiveCandidate(c);
    setEdit(buildEdit(c, preview));
  };

  // On-demand page-1 skim: one small LLM call, only when the user asks
  // (kept manual so bulk uploads never burn quota on this).
  const suggestFromPageOne = async () => {
    if (!preview || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const prompt = buildTitleAssistPrompt(pageOneText(preview.text ?? ""));
      const { provider, model } = settings.provider === "ollama"
        ? { provider: new OllamaProvider(), model: settings.model }
        : { provider: new CloudProvider(settings.cloudProvider), model: settings.cloudModel };
      const r = await provider.chat(
        [
          { role: "system", content: "You are a metadata-extraction function. Output ONLY the requested JSON." },
          { role: "user", content: prompt },
        ],
        { model, temperature: 0, numCtx: settings.numCtx, numPredict: 512 } as Parameters<typeof provider.chat>[1],
      );
      const parsed = parseTitleAssistJson((r.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, ""));
      setActiveCandidate(null);
      setEdit((prev: any) => ({
        ...prev,
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.authors.length ? { authors: parsed.authors.join(", ") } : {}),
        ...(parsed.year != null ? { year: String(parsed.year) } : {}),
        ...(parsed.venue ? { journal: parsed.venue } : {}),
        ...(parsed.doi ? { doi: parsed.doi } : {}),
      }));
    } catch (e: any) {
      setAiError(e?.message ?? "AI suggestion failed");
    } finally {
      setAiBusy(false);
    }
  };

  const confirm = async() => {
    if(!preview || !file) return;
    setLoading(true); setError(null);
    setPhase("Uploading → creating record → embedding chunks…");
    // Validate human-editable fields: raw Number("…")/DOI strings would
    // otherwise store NaN years and punctuated DOIs that break later dedup.
    const rawYear = String(edit.year ?? "").trim();
    const yearNum = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
    if (rawYear && (!Number.isInteger(yearNum) || yearNum < 1000 || yearNum > 2100)) {
      setLoading(false); setPhase("");
      setError(`Invalid year "${rawYear}" — use a 4-digit year 1000–2100 or leave it empty.`);
      return;
    }
    try{
      const r = await confirmIngest({
        file,
        preview,
        title: edit.title,
        authors: (edit.authors||"").split(",").map((s:string)=>s.trim()).filter(Boolean),
        year: rawYear ? yearNum : null,
        doi: cleanDoi(edit.doi) || null,
        journal: edit.journal || null,
        jurisdiction: edit.jurisdiction || null,
        document_type: edit.document_type || null,
        abstract: edit.abstract || null,
        volume: edit.volume || null,
        issue: edit.issue || null,
        pages: edit.pages || null,
        publisher: edit.publisher || null,
        citationMetadata: activeCandidate?.extras || {},
        metadataSource: activeCandidate?.source || "local",
        metadataConfidence: activeCandidate ? (activeCandidate.confidence ?? null) : null,
        collectionIds: edit.collection_ids || [],
        embedMode: settings.embedMode,
      });
      setResult({ document: { ...r.document, id: r.document.id }, indexing_error: r.indexingError });
      onDone?.();
    } catch(e:any){ setError(e.message); }
    finally{ setLoading(false); setPhase(""); }
  };

  const fetchedActive = activeCandidate && activeCandidate.source !== "local";
  const proposal = preview?.metadataProposal;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border-2 border-dashed border-[#2f2f2f] bg-[#0a0a0a] p-6 lg:p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-white text-black grid place-items-center text-xl">↑</div>
        <div className="mt-3 font-medium text-white">Drop a PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), or text file here</div>
        <div className="text-sm text-[#8e8e8e]">Local parsing • SHA-256 dedup • OpenAlex metadata lookup • Goes to pending approval — nothing is shared until an admin approves</div>
        <label className="mt-4 inline-flex cursor-pointer rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium hover:bg-[#ececec]">
          Choose file
          <input type="file" className="hidden" accept=".pdf,.docx,.xlsx,.xls,.pptx,.rtf,.txt,.md,.csv,.tsv,.html,.htm" onChange={e=> e.target.files?.[0] && startPreview(e.target.files[0])} />
        </label>
        {file && <div className="mt-3 text-xs font-mono text-[#8e8e8e] break-all">{file.name} • {(file.size/1024/1024).toFixed(2)} MB</div>}
        {loading && <div className="mt-3 text-sm text-white">{phase || "Analyzing…"}</div>}
        {error && <div className="mt-3 rounded-xl bg-red-950/30 border border-red-900 text-red-300 p-3 text-sm break-all">{error}</div>}
      </div>

      {preview && (
        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#2f2f2f] bg-[#171717] flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-widest font-semibold text-[#8e8e8e]">Proposed metadata — human confirms, system executes</div>
              <div className="text-sm text-[#b4b4b4] mt-1">Nothing is shared until you click <b className="text-white">Accept</b> (and an admin approves). Edit anything below.</div>
            </div>
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border self-start ${preview.decision==="auto_suggest" ? "bg-emerald-950 border-emerald-800 text-emerald-300" : preview.decision==="confirm" ? "bg-amber-950 border-amber-800 text-amber-300" : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e]"}`}>{preview.decision} • {Math.round(preview.collectionConfidence*100)}%</span>
          </div>

          {/* Metadata verification card: source + confidence, Accept/Edit/Reject */}
          {proposal && (
            <div className={`mx-5 mt-4 rounded-xl border p-3 ${fetchedActive ? "bg-emerald-950/30 border-emerald-800" : "bg-[#171717] border-[#2f2f2f]"}`}>
              {fetchedActive ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-white">Metadata found</span>
                    <span className="rounded-full bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-xs text-emerald-300">Source: {activeCandidate.source} ✓</span>
                    <span className="rounded-full bg-[#212121] border border-[#2f2f2f] px-2 py-0.5 text-xs text-[#ececec]">Match confidence: {Math.round((activeCandidate.confidence ?? 0)*100)}%</span>
                    {preview.offline && <span className="rounded-full bg-amber-950 border border-amber-800 px-2 py-0.5 text-xs text-amber-300">offline mode</span>}
                  </div>
                  {candidates.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-[#8e8e8e]">
                      <span>Other matches:</span>
                      <select
                        className="rounded-lg border border-[#2f2f2f] bg-black px-2 py-1 text-xs text-white outline-none"
                        onChange={e=>chooseCandidate(e.target.value)}
                        defaultValue=""
                      >
                        <option value="" className="bg-[#171717]">— keep best match —</option>
                        {candidates.map((c:any,i:number)=>(
                          <option key={i} value={i} className="bg-[#171717]">{c.title?.slice(0,80)} ({Math.round((c.confidence??0)*100)}%)</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="mt-2 text-xs text-[#8e8e8e]">
                    {activeCandidate.title} — {activeCandidate.journal || "no journal"} ({activeCandidate.year || "n.d."})
                  </div>
                  <button onClick={rejectProposal} className="mt-2 rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-xs text-white hover:bg-[#2f2f2f]">
                    Reject — use local extraction
                  </button>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-white">No external record</span>
                    <span className="rounded-full bg-[#212121] border border-[#2f2f2f] px-2 py-0.5 text-xs text-[#8e8e8e]">Source: local extraction</span>
                    {preview.metadataError && <span className="text-xs text-[#5f5f5f]">{preview.metadataError}</span>}
                  </div>
                  {candidates.length > 0 && (
                    <div className="text-xs text-amber-300">
                      OpenAlex found {candidates.length} match{candidates.length > 1 ? "es" : ""} below the auto-accept threshold — pick one manually or keep local:
                      <select
                        className="ml-2 rounded-lg border border-[#2f2f2f] bg-black px-2 py-1 text-xs text-white outline-none"
                        onChange={e=>chooseCandidate(e.target.value)}
                        defaultValue=""
                      >
                        <option value="" className="bg-[#171717]">— keep local extraction —</option>
                        {candidates.map((c:any,i:number)=>(
                          <option key={i} value={i} className="bg-[#171717]">{c.title?.slice(0,80)} ({Math.round((c.confidence??0)*100)}%)</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={suggestFromPageOne}
                      disabled={aiBusy}
                      className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-xs text-white hover:bg-[#2f2f2f] disabled:opacity-50"
                      title="One small model call over the first page only; fills title/authors/year/venue/DOI"
                    >
                      {aiBusy ? "Reading page 1…" : "✨ Suggest from page 1"}
                    </button>
                    <span className="text-[11px] text-[#5f5f5f]">One small call, first page only — fills empty fields below.</span>
                  </div>
                  {aiError && <div className="text-xs text-red-300">{aiError}</div>}
                  <div className="text-[11px] text-[#5f5f5f]">Check the title/year/journal below before Accept — Daftar Pustaka is built from these fields exactly.</div>
                </div>
              )}
            </div>
          )}

          {preview.isDuplicate && (
            <div className="mx-5 mt-4 rounded-xl bg-red-950/30 border border-red-900 p-3 text-sm text-red-300">
              ⚠ Possible duplicate detected
              <ul className="list-disc ml-5 mt-1 break-words">
                {preview.duplicates.map((d:any)=><li key={d.id}>{d.title} — {d.label} ({Math.round(d.confidence*100)}%)</li>)}
              </ul>
            </div>
          )}

          {preview.noText && !preview.extractionError && (
            <div className="mx-5 mt-4 rounded-xl bg-amber-950/30 border border-amber-800 p-3 text-sm text-amber-300">
              ⚠ No extractable text found in this file. If it is a scanned PDF (photos of pages),
              the library cannot search or answer from it until it is OCR&apos;d elsewhere and
              re-uploaded. Accepting will file it as metadata only.
            </div>
          )}

          {preview.extractionError && (
            <div className="mx-5 mt-4 rounded-xl bg-red-950/30 border border-red-900 p-3 text-sm text-red-300">
              ⚠ Document text extraction failed in your browser — accepting would file this as
              metadata only with nothing searchable.
              <div className="mt-1 font-mono text-xs break-all">{preview.extractionError}</div>
              <div className="mt-1 text-xs text-red-300/70">Try re-uploading; if it persists, report this message.</div>
            </div>
          )}

          <div className="p-5 grid gap-4 md:grid-cols-2">
            <label className="md:col-span-2 text-xs font-medium text-[#ececec]">Title<input value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Authors<input value={edit.authors} onChange={e=>setEdit({...edit,authors:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f]" placeholder="Comma separated" /></label>
            <label className="text-xs font-medium text-[#ececec]">Journal / Venue<input value={edit.journal} onChange={e=>setEdit({...edit,journal:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Year<input value={edit.year} onChange={e=>setEdit({...edit,year:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Type<input value={edit.document_type} onChange={e=>setEdit({...edit,document_type:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Jurisdiction<input value={edit.jurisdiction} onChange={e=>setEdit({...edit,jurisdiction:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">DOI<input value={edit.doi} onChange={e=>setEdit({...edit,doi:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Volume<input value={edit.volume} onChange={e=>setEdit({...edit,volume:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Issue<input value={edit.issue} onChange={e=>setEdit({...edit,issue:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="text-xs font-medium text-[#ececec]">Pages<input value={edit.pages} onChange={e=>setEdit({...edit,pages:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" placeholder="1-10" /></label>
            <label className="text-xs font-medium text-[#ececec]">Publisher<input value={edit.publisher} onChange={e=>setEdit({...edit,publisher:e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <label className="md:col-span-2 text-xs font-medium text-[#ececec]">Abstract<textarea value={edit.abstract} onChange={e=>setEdit({...edit,abstract:e.target.value})} rows={3} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white" /></label>
            <div className="md:col-span-2">
              <div className="text-xs font-medium text-[#ececec]">Collections</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {collections.map(c=>{
                  const on = (edit.collection_ids||[]).includes(c.id);
                  return <button key={c.id} onClick={()=>setEdit({...edit, collection_ids: on? edit.collection_ids.filter((x:string)=>x!==c.id) : [...(edit.collection_ids||[]), c.id]})} className={`rounded-full px-3 py-1.5 text-xs border flex items-center gap-1.5 ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}><span className="h-2 w-2 rounded-full" style={{background:c.color}} />{c.name}</button>
                })}
                {collections.length===0 && <span className="text-sm text-[#5f5f5f]">No collections — create one in the Library.</span>}
              </div>
              {preview.suggestedCollection && <div className="mt-2 text-xs text-[#8e8e8e]">Suggested: <b className="text-white">{preview.suggestedCollection.name}</b> — {preview.collectionReason} • {Math.round(preview.collectionConfidence*100)}% confidence</div>}
            </div>
            <div className="md:col-span-2 rounded-xl bg-[#171717] border border-[#2f2f2f] p-3">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Extraction preview</div>
              <div className="text-xs font-mono mt-2 whitespace-pre-wrap leading-relaxed text-[#b4b4b4] break-words">{preview.textSnippet?.slice(0,900)}</div>
              <div className="text-xs text-[#5f5f5f] mt-2 break-all">Hash {preview.fileHash.slice(0,16)}… • {preview.pageCount ?? "?"} pages • {preview.mimeType}</div>
            </div>
          </div>

          <div className="px-5 py-4 border-t border-[#2f2f2f] flex flex-col sm:flex-row gap-3 bg-black">
            <button onClick={confirm} disabled={loading} className="flex-1 rounded-xl bg-white text-black py-3 text-sm font-semibold disabled:opacity-50 hover:bg-[#ececec]">Accept & Index — {loading ? "Indexing…" : "Ready"}</button>
            <button onClick={()=>{ setPreview(null); setFile(null); }} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-6 py-3 text-sm text-white hover:bg-[#2f2f2f]">Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-2xl border border-emerald-900 bg-emerald-950/30 p-4">
          <div className="text-sm font-medium text-emerald-300">✓ Accepted — {result.document.title}</div>
          <div className="text-xs mt-1 text-emerald-400/70">Status: pending admin approval • Metadata source: {result.document.metadata_source}{result.document.metadata_confidence != null ? ` • ${Math.round(result.document.metadata_confidence*100)}%` : ""}</div>
          {result.indexing_error && <div className="text-xs mt-2 text-amber-300 bg-amber-950/30 border border-amber-900 rounded-lg p-2 break-all">Indexing warning: {String(result.indexing_error).slice(0,400)}</div>}
          <div className="text-xs text-emerald-400/70 mt-1 break-all">Stored at {result.document.stored_path} • {result.document.ingestion_status}</div>
        </div>
      )}
    </div>
  );
}
