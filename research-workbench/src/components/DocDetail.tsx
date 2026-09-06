"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function DocDetail({ id, onClose, onUpdated }: { id: string | null; onClose: ()=>void; onUpdated?: ()=>void }) {
  const [doc, setDoc] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [cols, setCols] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"meta"|"ask"|"cite"|"related"|"refs"|"notes">("meta");
  const [askQ, setAskQ] = useState("");
  const [askAns, setAskAns] = useState<any>(null);
  const [askLoading, setAskLoading] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [sumLoading, setSumLoading] = useState(false);
  const [citations, setCitations] = useState<any>(null);
  const [citationStyles, setCitationStyles] = useState<any[]>([]);
  const [citeStyle, setCiteStyle] = useState<string>("apa");
  const [related, setRelated] = useState<any>(null);
  const [references, setReferences] = useState<any>(null);

  useEffect(()=>{
    if(!id) return;
    api.getDocument(id).then(d=>{ setDoc(d); setEdit({ title:d.title, authors:(d.authors||[]).join(", "), year:d.year||"", journal:d.journal||"", doi:d.doi||"", jurisdiction:d.jurisdiction||"", document_type:d.document_type||"", abstract:d.abstract||"", volume:d.volume||"", issue:d.issue||"", pages:d.pages||"", publisher:d.publisher||"" }); }).catch(()=>{});
    api.collections().then(setCols).catch(()=>{});
    api.tags().then(setTags).catch(()=>{});
    setAskAns(null); setSummary(null); setCitations(null); setRelated(null); setReferences(null);
    api.citationStyles().then(r=>{ setCitationStyles(r.styles||[]); setCiteStyle(r.default||"apa"); }).catch(()=>{});
  },[id]);

  if(!id) return null;
  if(!doc) return <div className="w-full sm:w-[480px] h-full border-l border-[#2f2f2f] bg-[#0a0a0a] p-6 text-sm text-[#8e8e8e]">Loading…</div>;

  const save = async()=>{
    setSaving(true);
    try{
      const authors = edit.authors.split(",").map((s:string)=>s.trim()).filter(Boolean);
      await api.updateDocument(id, { title: edit.title, doi: edit.doi || null, year: edit.year? Number(edit.year): null, journal: edit.journal || null, jurisdiction: edit.jurisdiction || null, document_type: edit.document_type || null, abstract: edit.abstract || null, volume: edit.volume || null, issue: edit.issue || null, pages: edit.pages || null, publisher: edit.publisher || null, authors });
      const fresh = await api.getDocument(id);
      setDoc(fresh); onUpdated?.();
    } catch(e:any){ alert(e.message); }
    finally{ setSaving(false); }
  };

  const ask = async()=>{
    if(!askQ.trim()) return;
    setAskLoading(true); setAskAns(null);
    try{
      const r = await api.ask({ query: askQ, document_ids: [id] });
      setAskAns(r);
    } catch(e:any){ setAskAns({ answer: "Error: "+e.message, sources: [] }); }
    finally{ setAskLoading(false); }
  };

  const doSummarize = async()=>{
    setSumLoading(true);
    try{
      const r = await api.summarize({ document_id: id });
      setSummary(r);
    } catch(e:any){ setSummary({ summary: "Error: "+e.message }); }
    finally{ setSumLoading(false); }
  };

  const loadCitations = async(style?: string)=>{
    const s = style ?? citeStyle;
    setCiteStyle(s);
    try {
      setCitations(await api.citations(id, s));
    } catch(e:any){ setCitations({ citation: "Error: "+e.message, style: s }); }
  };

  const openPdf = async()=>{
    try{
      const url = await api.documentFileUrl(doc);
      if(url) window.open(url, "_blank");
    } catch(e:any){ alert(e.message); }
  };

  return (
    <div className="w-full sm:w-[480px] h-screen bg-[#0a0a0a] border-l border-[#2f2f2f] flex flex-col shadow-2xl">
      <div className="px-5 py-4 border-b border-[#2f2f2f] flex items-center gap-3 bg-[#0a0a0a] shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] tracking-widest uppercase text-[#8e8e8e] font-semibold">Document</div>
          <div className="font-medium truncate text-white">{doc.title}</div>
          <div className="text-xs text-[#8e8e8e] truncate">{doc.original_filename} • {doc.file_size ? `${(doc.file_size/1024/1024).toFixed(2)} MB` : ""} {doc.page_count ? `• ${doc.page_count} pages` : ""}</div>
        </div>
        <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-full bg-[#212121] hover:bg-[#2f2f2f] border border-[#2f2f2f] text-white shrink-0">✕</button>
      </div>

      <div className="flex gap-1 p-2 border-b border-[#2f2f2f] bg-[#000]">
        {[
          ["meta","Metadata"],
          ["ask","Ask"],
          ["cite","Cite"],
          ["related","Related"],
          ["refs","Refs"],
          ["notes","Notes"],
        ].map(([k,label])=>(
          <button key={k} onClick={()=>{ setTab(k as any); if(k==="cite" && !citations) loadCitations(); if(k==="related" && !related) api.related(id).then(setRelated).catch(()=>{}); if(k==="refs" && !references) api.references(id, true).then(setReferences).catch(()=>{}); }} className={`flex-1 rounded-lg px-3 py-1.5 text-sm ${tab===k? "bg-white text-black shadow-sm font-medium":"text-[#8e8e8e] hover:text-white hover:bg-[#171717]"}`}>{label}</button>
        ))}
      </div>

      <div className="flex-1 overflow-auto bg-[#0a0a0a]">
        {tab==="meta" && (
          <div className="p-5 space-y-4">
            <div className="grid gap-3">
              <label className="text-xs font-medium text-[#ececec]">Title<input value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs font-medium text-[#ececec]">Authors (comma-separated)<input value={edit.authors} onChange={e=>setEdit({...edit,authors:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" placeholder="Jane Doe, John Smith" /></label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs font-medium text-[#ececec]">Year<input value={edit.year} onChange={e=>setEdit({...edit,year:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
                <label className="text-xs font-medium text-[#ececec]">Type<input value={edit.document_type} onChange={e=>setEdit({...edit,document_type:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" placeholder="legal / empirical / survey" /></label>
              </div>
              <label className="text-xs font-medium text-[#ececec]">Journal / Venue<input value={edit.journal} onChange={e=>setEdit({...edit,journal:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs font-medium text-[#ececec]">DOI<input value={edit.doi} onChange={e=>setEdit({...edit,doi:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs font-medium text-[#ececec]">Volume<input value={edit.volume} onChange={e=>setEdit({...edit,volume:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
                <label className="text-xs font-medium text-[#ececec]">Issue<input value={edit.issue} onChange={e=>setEdit({...edit,issue:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
                <label className="text-xs font-medium text-[#ececec]">Pages<input value={edit.pages} onChange={e=>setEdit({...edit,pages:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" placeholder="1-10" /></label>
              </div>
              <label className="text-xs font-medium text-[#ececec]">Publisher<input value={edit.publisher} onChange={e=>setEdit({...edit,publisher:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs font-medium text-[#ececec]">Jurisdiction<input value={edit.jurisdiction} onChange={e=>setEdit({...edit,jurisdiction:e.target.value})} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs font-medium text-[#ececec]">Abstract<textarea value={edit.abstract} onChange={e=>setEdit({...edit,abstract:e.target.value})} rows={4} className="mt-1 w-full rounded-lg border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
            </div>

            <div className="flex gap-2">
              <button onClick={save} disabled={saving} className="flex-1 rounded-xl bg-white text-black py-2.5 text-sm font-medium disabled:opacity-50">{saving? "Saving…":"Save changes"}</button>
              <button onClick={openPdf} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2.5 text-sm text-white hover:bg-[#2f2f2f]">Open PDF ↗</button>
            </div>

            <div className="space-y-3 pt-3 border-t border-[#2f2f2f]">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Collections</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {cols.map(c=>{
                    const active = (doc.collections||[]).some((x:any)=>x.id===c.id);
                    return <button key={c.id} onClick={async()=>{ const ids = active? doc.collections.filter((x:any)=>x.id!==c.id).map((x:any)=>x.id) : [...doc.collections.map((x:any)=>x.id), c.id]; await api.setCollections(id, ids); const fresh=await api.getDocument(id); setDoc(fresh); onUpdated?.(); }} className={`rounded-full px-3 py-1 text-xs border ${active? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec] hover:border-[#404040]"}`}><span className="h-2 w-2 rounded-full inline-block mr-1" style={{background:c.color}} />{c.name}</button>
                  })}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Tags</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tags.map(t=>{
                    const active = (doc.tags||[]).some((x:any)=>x.id===t.id);
                    return <button key={t.id} onClick={async()=>{ const ids = active? doc.tags.filter((x:any)=>x.id!==t.id).map((x:any)=>x.id) : [...doc.tags.map((x:any)=>x.id), t.id]; await api.setTags(id, ids); const fresh=await api.getDocument(id); setDoc(fresh); onUpdated?.(); }} className={`rounded-full px-2.5 py-1 text-xs border ${active? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>#{t.name}</button>
                  })}
                </div>
              </div>
              <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 text-xs leading-relaxed">
                <div className="font-medium text-white">Provenance</div>
                <div className="text-[#8e8e8e] mt-1">Hash <span className="font-mono text-[#ececec]">{doc.file_hash?.slice(0,16)}…</span> • {doc.ingestion_status} {doc.ingestion_error ? `• ${doc.ingestion_error.slice(0,120)}` : ""} • {doc.status}</div>
                <div className="text-[#8e8e8e]">Metadata: <span className="text-[#ececec]">{doc.metadata_source || "unknown"}</span>{doc.metadata_confidence != null ? ` • ${Math.round(doc.metadata_confidence*100)}% confidence` : ""} • {doc.metadata_verified ? "verified" : "unverified"}{doc.metadata_fetched_at ? ` • ${new Date(doc.metadata_fetched_at).toLocaleString()}` : ""}</div>
                <div className="text-[#8e8e8e] break-all">Stored at <span className="font-mono text-[#ececec]">{doc.storage_path}</span></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={doSummarize} disabled={sumLoading} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50">{sumLoading? "Summarizing…":"Summarize"}</button>
                {summary && <button onClick={()=>setTab("ask")} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">View</button>}
              </div>
              {summary && <div className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3 text-sm leading-relaxed whitespace-pre-wrap text-[#ececec]">{summary.summary?.slice(0,8000)}</div>}
            </div>
          </div>
        )}

        {tab==="ask" && (
          <div className="p-5 space-y-4">
            <div className="flex gap-2">
              <input value={askQ} onChange={e=>setAskQ(e.target.value)} onKeyDown={e=> e.key==="Enter" && ask()} placeholder={`Ask this document…`} className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f]" />
              <button onClick={ask} disabled={askLoading} className="rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium disabled:opacity-50">{askLoading? "…" : "Ask"}</button>
            </div>
            {askAns && (
              <div className="space-y-3">
                <div className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-4 text-sm leading-relaxed whitespace-pre-wrap text-[#ececec]">{askAns.answer}</div>
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Evidence</div>
                  {(askAns.sources||[]).map((s:any,i:number)=>(
                    <div key={i} className="rounded-xl border border-[#2f2f2f] bg-black p-3">
                      <div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation}</div>
                      <div className="text-sm mt-1 leading-relaxed text-[#ececec]">{s.snippet}</div>
                    </div>
                  ))}
                  {(askAns.sources||[]).length===0 && <div className="text-sm text-[#8e8e8e]">No passages returned.</div>}
                </div>
              </div>
            )}
            {!askAns && <div className="text-sm text-[#8e8e8e]">Ask a question scoped to this document. Uses hybrid FTS + vector retrieval over your own model.</div>}
          </div>
        )}

        {tab==="cite" && (
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <select value={citeStyle} onChange={e=>loadCitations(e.target.value)} className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white outline-none">
                {citationStyles.map((s:any)=> <option key={s.id} value={s.id} className="bg-[#171717]">{s.title}</option>)}
              </select>
              <button onClick={()=>loadCitations()} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-sm text-white">↻</button>
            </div>
            <div className="text-xs text-[#8e8e8e]">CSL rendering (citeproc-js, same vendored styles). Set the default in Settings → Citation.</div>
            {!citations ? <div className="text-sm text-[#8e8e8e]">Loading…</div> : (
              <>
                <div className="rounded-xl border border-[#2f2f2f] bg-[#171717]">
                  <div className="px-3 py-2 border-b border-[#2f2f2f] flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">{citations.style}</span>
                    <button onClick={()=>navigator.clipboard.writeText(String(citations.citation))} className="text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 text-white hover:bg-[#2f2f2f]">Copy</button>
                  </div>
                  <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed text-[#ececec]">{citations.citation}</pre>
                </div>
                {[
                  ["BibTeX", citations.bibtex],
                  ["RIS", citations.ris],
                  ["Plain (in-text locator)", citations.plain],
                ].map(([label, val])=>(
                  <div key={label} className="rounded-xl border border-[#2f2f2f] bg-[#171717]">
                    <div className="px-3 py-2 border-b border-[#2f2f2f] flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">{label}</span>
                      <button onClick={()=>navigator.clipboard.writeText(String(val))} className="text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 text-white hover:bg-[#2f2f2f]">Copy</button>
                    </div>
                    <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed text-[#ececec]">{String(val)}</pre>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab==="related" && (
          <div className="p-5 space-y-4">
            <div className="text-sm text-[#8e8e8e]">Relationships are labeled by mechanism — semantic similarity is never presented as a confirmed scholarly link.</div>
            {!related ? <div className="text-sm text-[#8e8e8e]">Loading…</div> : (
              <>
                {[
                  ["citations","Citation relationships (from the legal citation graph)"],
                  ["shared_authors","Shared authors"],
                  ["shared_topics","Shared topics (tags & collections)"],
                  ["semantic","Semantic similarity (embeddings)"],
                ].map(([key,label])=>(
                  <div key={key}>
                    <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">{label}</div>
                    <div className="mt-2 space-y-1.5">
                      {(related[key]||[]).map((r:any,i:number)=>(
                        <div key={i} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2">
                          <div className="text-sm text-white truncate">{r.title}</div>
                          <div className="text-xs text-[#5f5f5f]">{r.reason}</div>
                        </div>
                      ))}
                      {(related[key]||[]).length===0 && <div className="text-sm text-[#5f5f5f]">—</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab==="refs" && (
          <div className="p-5 space-y-3">
            <div className="text-sm text-[#8e8e8e]">Reference list extracted from the document text. Entries matching a library document are linked (jump straight to the cited work).</div>
            {!references ? <div className="text-sm text-[#8e8e8e]">Loading…</div> : (
              <div className="space-y-2">
                {references.references.map((r:any)=>(
                  <div key={r.number} className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[#8e8e8e]">[{r.number}]</span>
                      <span className="text-sm text-white break-words">{r.text}</span>
                    </div>
                    {r.match && <div className="mt-1.5 text-xs text-emerald-300">→ in library: {r.match.title} ({Math.round(r.match.score*100)}%)</div>}
                  </div>
                ))}
                {references.references.length===0 && <div className="text-sm text-[#8e8e8e]">No bracketed references detected in this document.</div>}
              </div>
            )}
          </div>
        )}

        {tab==="notes" && (
          <div className="p-5 space-y-3">
            <div className="text-sm text-[#8e8e8e]">Notes & highlights for this document. Highlights are stored as structured data in the shared workspace, not burned into the PDF.</div>
            <AnnotationsPanel docId={id} />
          </div>
        )}
      </div>
    </div>
  );
}

function AnnotationsPanel({ docId }: { docId:string }) {
  const [items, setItems] = useState<any[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const load = ()=> api.annotations(docId).then(setItems).catch(()=>{});
  useEffect(()=>{ load(); },[docId]);
  const add = async()=>{
    if(!text.trim()) return;
    await api.createAnnotation(docId, { page: 1, selected_text: text, note, color: "#facc15" });
    setText(""); setNote(""); load();
  };
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3 space-y-2">
        <input value={text} onChange={e=>setText(e.target.value)} placeholder="Selected text…" className="w-full rounded-lg border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
        <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Note (optional)…" className="w-full rounded-lg border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
        <button onClick={add} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium">Add highlight</button>
      </div>
      <div className="space-y-2">
        {items.map(a=>(
          <div key={a.id} className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3">
            <div className="text-xs text-[#8e8e8e]">p. {a.page} • {a.category} • {new Date(a.created_at).toLocaleString()}</div>
            <div className="text-sm mt-1 text-white">“{a.selected_text}”</div>
            {a.note && <div className="text-sm mt-1 text-[#ececec] bg-black rounded-lg px-2 py-1 border border-[#2f2f2f]">{a.note}</div>}
          </div>
        ))}
        {items.length===0 && <div className="text-sm text-[#8e8e8e]">No highlights yet.</div>}
      </div>
    </div>
  );
}
