"use client";
import { useEffect, useMemo, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import Topbar from "@/components/Topbar";
import DocDetail from "@/components/DocDetail";

function LibraryInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [docs, setDocs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [collections, setCollections] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [yearFilter, setYearFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [newColl, setNewColl] = useState("");
  const [newTag, setNewTag] = useState("");

  const activeCollection = searchParams.get("collection");
  const activeTag = searchParams.get("tag");

  const load = async () => {
    const params: any = {};
    if (q) params.q = q;
    if (activeCollection) params.collection_id = activeCollection;
    if (activeTag) params.tag_id = activeTag;
    if (yearFilter) params.year = yearFilter;
    if (typeFilter) params.doc_type = typeFilter;
    const r = await api.listDocuments(params);
    setDocs(r.documents); setTotal(r.total);
  };
  const loadMeta = async()=>{
    try{ setCollections(await api.collections()); }catch{}
    try{ setTags(await api.tags()); }catch{}
  };
  useEffect(()=>{ load(); },[q, activeCollection, activeTag, yearFilter, typeFilter]);
  useEffect(()=>{ loadMeta(); },[]);
  useEffect(()=>{ const id=setInterval(loadMeta, 3000); return ()=>clearInterval(id); },[]);

  const filteredInfo = useMemo(()=>{
    const parts=[];
    if(activeCollection){ const c=collections.find(x=> String(x.id)===activeCollection); parts.push(`Collection: ${c?.name || activeCollection}`); }
    if(activeTag){ const t=tags.find(x=> String(x.id)===activeTag); parts.push(`Tag: #${t?.name || activeTag}`); }
    if(yearFilter) parts.push(`Year ${yearFilter}`);
    if(typeFilter) parts.push(typeFilter);
    return parts.join(" • ");
  },[activeCollection, activeTag, collections, tags, yearFilter, typeFilter]);

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 flex flex-col bg-black">
        <Topbar title="Library" subtitle={filteredInfo || `${total} documents • SQLite is source of truth`} actions={
          <div className="flex items-center gap-2">
            <button onClick={()=>router.push("/upload")} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-[#ececec]">+ Upload</button>
            {(activeCollection || activeTag || yearFilter || typeFilter) && <button onClick={()=>{ router.push("/"); setYearFilter(""); setTypeFilter(""); setQ(""); }} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-4 py-2 text-sm text-[#ececec]">Clear</button>}
          </div>
        } />

        <div className="px-4 lg:px-6 py-4 space-y-4 flex-1 overflow-auto">
          {/* controls */}
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1 min-w-0">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8e8e]">⌕</span>
              <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search titles, journals, DOI…" className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] pl-9 pr-3 py-2.5 text-sm placeholder:text-[#5f5f5f] text-white focus:border-[#404040] focus:ring-1 focus:ring-white/10 outline-none" />
            </div>
            <div className="flex gap-2">
              <select value={yearFilter} onChange={e=>setYearFilter(e.target.value)} className="flex-1 lg:flex-none rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white">
                <option value="">All years</option>
                {Array.from({length: 12}, (_,i)=> String(new Date().getFullYear()-i)).map(y=> <option key={y} value={y}>{y}</option>)}
              </select>
              <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} className="flex-1 lg:flex-none rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white">
                <option value="">All types</option>
                <option value="legal">Legal</option>
                <option value="empirical">Empirical</option>
                <option value="survey">Survey</option>
                <option value="general">General</option>
              </select>
            </div>
          </div>

          {/* quick add */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-[#2f2f2f] bg-[#0a0a0a] px-3 py-2 flex-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e] hidden sm:inline">New collection</span>
              <input value={newColl} onChange={e=>setNewColl(e.target.value)} placeholder="e.g. Legal Theory" className="flex-1 rounded-lg border border-[#2f2f2f] bg-[#171717] px-2 py-1.5 text-sm text-white placeholder:text-[#5f5f5f]" />
              <button onClick={async()=>{ if(!newColl.trim()) return; await api.createCollection({name:newColl}); setNewColl(""); loadMeta(); }} className="rounded-lg bg-white text-black px-3 py-1.5 text-sm font-medium">Add</button>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-[#2f2f2f] bg-[#0a0a0a] px-3 py-2 flex-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e] hidden sm:inline">New tag</span>
              <input value={newTag} onChange={e=>setNewTag(e.target.value)} placeholder="constitutional-law" className="flex-1 rounded-lg border border-[#2f2f2f] bg-[#171717] px-2 py-1.5 text-sm text-white placeholder:text-[#5f5f5f]" />
              <button onClick={async()=>{ if(!newTag.trim()) return; await api.createTag({name:newTag}); setNewTag(""); loadMeta(); }} className="rounded-lg bg-[#212121] border border-[#2f2f2f] px-3 py-1.5 text-sm text-white">Add</button>
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] overflow-hidden">
            <div className="overflow-auto">
              <table className="w-full text-sm table-fixed">
                <thead className="bg-[#171717] border-b border-[#2f2f2f] text-xs uppercase tracking-widest text-[#8e8e8e]">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold w-[45%]">Title</th>
                    <th className="text-left px-3 py-3 font-semibold w-20">Year</th>
                    <th className="text-left px-3 py-3 font-semibold w-27.5">Type</th>
                    <th className="text-left px-3 py-3 font-semibold w-[18%]">Collections</th>
                    <th className="text-left px-3 py-3 font-semibold w-[14%]">Tags</th>
                    <th className="text-right px-4 py-3 font-semibold w-30">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#212121]">
                  {docs.map(d=>(
                    <tr key={d.id} className={`hover:bg-[#171717] ${selected===d.id? "bg-[#212121]":""}`}>
                      <td className="px-4 py-3 align-top">
                        <button onClick={()=>setSelected(d.id)} className="text-left w-full group">
                          <div className="font-medium leading-tight text-white group-hover:text-[#ab68ff] wrap-break-word line-clamp-2">{d.title}</div>
                          {/* FIXED: second line now wraps/breaks instead of collapsing, separate from year */}
                          <div className="text-xs text-[#8e8e8e] mt-1 leading-relaxed wrap-break-word">
                            <span className="inline">{d.original_filename}</span>
                            <span className="mx-1 text-[#5f5f5f]">•</span>
                            <span className="inline wrap-break-word">{d.authors?.join(", ") || "—"}</span>
                            {d.jurisdiction && (
                              <>
                                <span className="mx-1 text-[#5f5f5f]">•</span>
                                <span className="inline wrap-break-word text-[#b4b4b4]">{d.jurisdiction}</span>
                              </>
                            )}
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-3 align-top text-[#ececec] font-mono text-xs whitespace-nowrap">{d.year || "—"}</td>
                      <td className="px-3 py-3 align-top"><span className="rounded-full bg-[#212121] border border-[#2f2f2f] px-2 py-0.5 text-xs text-[#ececec] whitespace-nowrap">{d.document_type || "general"}</span></td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {(d.collections||[]).slice(0,2).map((c:any)=><span key={c.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs bg-[#171717] text-[#ececec] whitespace-nowrap" style={{borderColor: c.color}}><span className="h-1.5 w-1.5 rounded-full shrink-0" style={{background:c.color}} />{c.name}</span>)}
                          {(d.collections||[]).length>2 && <span className="text-xs text-[#8e8e8e]">+{d.collections.length-2}</span>}
                          {(d.collections||[]).length===0 && <span className="text-xs text-[#5f5f5f]">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {(d.tags||[]).slice(0,3).map((t:any)=><span key={t.id} className="rounded-full bg-white text-black px-2 py-0.5 text-xs whitespace-nowrap">#{t.name}</span>)}
                          {(d.tags||[]).length===0 && <span className="text-xs text-[#5f5f5f]">—</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-right">
                        <div className="inline-flex gap-1">
                          <button onClick={()=>setSelected(d.id)} className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-2.5 py-1 text-xs text-white hover:bg-[#2f2f2f]">Open</button>
                          <button onClick={async()=>{ if(!confirm(`Delete "${d.title}"?`)) return; await api.deleteDocument(d.id); load(); if(selected===d.id) setSelected(null); }} className="rounded-lg border border-red-900/50 text-red-400 bg-[#171717] px-2.5 py-1 text-xs hover:bg-red-950/30">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {docs.length===0 && (
                    <tr><td colSpan={6} className="px-6 py-12 text-center">
                      <div className="mx-auto max-w-md">
                        <div className="h-10 w-10 mx-auto rounded-xl bg-[#171717] border border-[#2f2f2f] grid place-items-center text-[#8e8e8e]">◧</div>
                        <div className="mt-3 font-medium text-white">No documents yet</div>
                        <div className="text-sm text-[#8e8e8e] mt-1">Upload a PDF to see it here. Duplicates flagged via SHA-256 → DOI → title → fuzzy.</div>
                        <button onClick={()=>router.push("/upload")} className="mt-4 rounded-xl bg-white text-black px-4 py-2 text-sm font-medium">Upload your first paper</button>
                      </div>
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {docs.map(d=>(
              <div key={d.id} onClick={()=>setSelected(d.id)} className={`rounded-2xl border p-4 cursor-pointer ${selected===d.id? "bg-[#212121] border-white/20" : "bg-[#0a0a0a] border-[#2f2f2f] active:bg-[#171717]"}`}>
                <div className="font-medium text-white leading-tight wrap-break-word">{d.title}</div>
                <div className="text-xs text-[#8e8e8e] mt-1.5 leading-relaxed wrap-break-word">
                  {d.original_filename} • {d.authors?.join(", ") || "—"} {d.jurisdiction ? `• ${d.jurisdiction}` : ""}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <span className="rounded-full bg-[#212121] border border-[#2f2f2f] px-2 py-0.5 text-xs text-[#ececec]">{d.year || "—"} • {d.document_type || "general"}</span>
                  {(d.collections||[]).map((c:any)=><span key={c.id} className="rounded-full border px-2 py-0.5 text-xs bg-[#171717] text-[#ececec]" style={{borderColor:c.color}}>{c.name}</span>)}
                  {(d.tags||[]).map((t:any)=><span key={t.id} className="rounded-full bg-white text-black px-2 py-0.5 text-xs">#{t.name}</span>)}
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={(e)=>{ e.stopPropagation(); setSelected(d.id); }} className="flex-1 rounded-xl bg-white text-black py-2 text-sm font-medium">Open</button>
                  <button onClick={async(e)=>{ e.stopPropagation(); if(!confirm(`Delete "${d.title}"?`)) return; await api.deleteDocument(d.id); load(); }} className="rounded-xl border border-[#2f2f2f] px-4 py-2 text-sm text-[#8e8e8e]">Delete</button>
                </div>
              </div>
            ))}
            {docs.length===0 && (
              <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-8 text-center">
                <div className="h-10 w-10 mx-auto rounded-xl bg-[#171717] border border-[#2f2f2f] grid place-items-center text-[#8e8e8e]">◧</div>
                <div className="mt-3 font-medium text-white">No documents</div>
                <div className="text-sm text-[#8e8e8e] mt-1">Upload a PDF.</div>
              </div>
            )}
          </div>

          <div className="text-xs text-[#5f5f5f] pb-4">Showing {docs.length} of {total} • <span className="font-mono">SQLite is source of truth</span></div>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 lg:static lg:inset-auto flex">
          <button className="hidden lg:block flex-1 bg-black/60 backdrop-blur-sm" onClick={()=>setSelected(null)} aria-label="close" />
          <div className="ml-auto w-full sm:w-120 lg:w-120 h-full">
            <DocDetail id={selected} onClose={()=>setSelected(null)} onUpdated={load} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function LibraryPage(){
  return <Suspense fallback={<div className="p-6 text-sm text-[#8e8e8e]">Loading library…</div>}><LibraryInner /></Suspense>;
}
