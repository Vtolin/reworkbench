"use client";
import { useEffect, useState } from "react";
import Topbar from "@/components/Topbar";
import { api } from "@/lib/api";

export default function SearchPage(){
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<any[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const loadSaved = ()=> api.searches().then(setSaved).catch(()=>{});
  useEffect(()=>{ loadSaved(); },[]);

  const doSearch = async(query?: string)=>{
    const qq = query ?? q;
    if(!qq.trim()) return;
    setQ(qq);
    setLoading(true); setErr(null);
    try{ const r = await api.search(qq); setRes(r); } catch(e:any){ setErr(e.message); }
    finally{ setLoading(false); }
  };

  const saveSearch = async()=>{
    if(!q.trim() || !saveName.trim()) return;
    try{ await api.createSearch({ name: saveName, query: q, filters: {} }); setSaveName(""); setSaveMsg("Saved"); loadSaved(); }
    catch(e:any){ setSaveMsg(e.message); }
  };

  const runSaved = async(id: number)=>{
    setLoading(true);
    try{ setRes(await api.runSearch(id)); } catch(e:any){ setErr(e.message); }
    finally{ setLoading(false); }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Search" subtitle='Single search box • Results grouped into Documents / Passages / Authors / Collections / Tags • Filters: author:"John Smith" year:2024 tag:constitutional-law collection:"Legal Theory"' />
      <div className="px-4 lg:px-6 py-6 space-y-6">
        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8e8e8e]">⌕</span>
              <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=> e.key==="Enter" && doSearch()} placeholder='e.g. proportionality year:2023  or  author:"Putusan MK"  or  tag:legal' className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] pl-9 pr-3 py-3 text-[15px] text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]" />
            </div>
            <button onClick={()=>doSearch()} disabled={loading} className="rounded-xl bg-white text-black px-6 py-3 text-sm font-medium disabled:opacity-50 hover:bg-[#ececec] w-full sm:w-auto">{loading? "Searching…":"Search"}</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {['year:2024','tag:legal','author:"Mahkamah Konstitusi"','collection:"Research"','Pasal 28 year:2023'].map(ex=>(
              <button key={ex} onClick={()=>setQ(ex)} className="rounded-full border border-[#2f2f2f] bg-[#171717] px-3 py-1 text-[#ececec] hover:bg-[#212121]">{ex}</button>
            ))}
          </div>
          {/* saved searches */}
          <div className="mt-3 border-t border-[#2f2f2f] pt-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Saved searches</span>
              <input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder="Name this query…" className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-1.5 text-xs text-white placeholder:text-[#5f5f5f]" />
              <button onClick={saveSearch} disabled={!q.trim() || !saveName.trim()} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white disabled:opacity-40">Save current query</button>
              {saveMsg && <span className="text-xs text-[#5f5f5f]">{saveMsg}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {saved.map(s=>(
                <span key={s.id} className="flex items-center gap-1.5 rounded-full border border-[#2f2f2f] bg-[#171717] pl-3 pr-1 py-1 text-xs text-[#ececec]">
                  <button onClick={()=>runSaved(s.id)} className="hover:text-white">{s.name}</button>
                  <button onClick={async()=>{ await api.deleteSearch(s.id); loadSaved(); }} className="text-[#5f5f5f] hover:text-red-400 px-1">✕</button>
                </span>
              ))}
              {saved.length===0 && <span className="text-xs text-[#5f5f5f]">None yet — search, then save it to re-run as your library grows.</span>}
            </div>
          </div>
          {err && <div className="mt-3 rounded-xl bg-red-950/30 border border-red-900 text-red-300 p-3 text-sm">{err}</div>}
        </div>

        {!res && !loading && (
          <div className="rounded-2xl border border-dashed border-[#2f2f2f] bg-[#0a0a0a] p-10 text-center">
            <div className="text-sm text-[#8e8e8e]">Try a search above. Passages use hybrid BM25 + vector + cross-encoder rerank (ms-marco-MiniLM-L-12-v2).</div>
          </div>
        )}

        {res && (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4 min-w-0">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8e8e8e]">Documents • {res.counts.documents}</h2>
                <span className="text-xs text-[#5f5f5f] truncate ml-2">query “{res.query}”</span>
              </div>
              <div className="space-y-3">
                {res.results.documents.map((d:any)=>(
                  <div key={d.id} className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4">
                    <div className="font-medium leading-tight text-white break-words">{d.title}</div>
                    <div className="text-xs text-[#8e8e8e] mt-1 break-words">{d.original_filename} • {d.year || "—"} • {d.jurisdiction || "—"}</div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {(d.tag_names||[]).map((t:string)=> <span key={t} className="rounded-full bg-white text-black px-2 py-0.5 text-xs">#{t}</span>)}
                      {(d.collection_names||[]).map((c:string)=> <span key={c} className="rounded-full border border-[#2f2f2f] px-2 py-0.5 text-xs bg-[#171717] text-[#ececec]">{c}</span>)}
                    </div>
                  </div>
                ))}
                {res.results.documents.length===0 && <div className="text-sm text-[#8e8e8e]">No documents matched.</div>}
              </div>

              <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8e8e8e] pt-4">Authors • {res.counts.authors}</h2>
              <div className="flex flex-wrap gap-2">
                {res.results.authors.map((a:any)=> <span key={a.id} className="rounded-full border border-[#2f2f2f] bg-[#171717] px-3 py-1 text-sm text-white">{a.name}</span>)}
                {res.results.authors.length===0 && <span className="text-sm text-[#5f5f5f]">—</span>}
              </div>

              <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8e8e8e] pt-2">Collections • {res.counts.collections}</h2>
              <div className="space-y-2">
                {res.results.collections.map((c:any)=> <div key={c.id} className="rounded-xl border border-[#2f2f2f] bg-[#0a0a0a] px-3 py-2 flex items-center gap-2 text-white"><span className="h-2 w-2 rounded-full" style={{background:c.color}} />{c.name} <span className="ml-auto text-xs bg-[#212121] border border-[#2f2f2f] rounded-full px-2 py-0.5 text-[#8e8e8e]">{c.document_count}</span></div>)}
                {res.results.collections.length===0 && <span className="text-sm text-[#5f5f5f]">—</span>}
              </div>

              <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8e8e8e] pt-2">Tags • {res.counts.tags}</h2>
              <div className="flex flex-wrap gap-2">
                {res.results.tags.map((t:any)=> <span key={t.id} className="rounded-full bg-[#171717] border px-3 py-1 text-sm text-[#ececec]" style={{borderColor:"#2f2f2f"}}>#{t.name}</span>)}
                {res.results.tags.length===0 && <span className="text-sm text-[#5f5f5f]">—</span>}
              </div>
            </div>

            <div className="space-y-4 min-w-0">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-[#8e8e8e]">Passages • {res.counts.passages} <span className="normal-case tracking-normal font-normal text-[#5f5f5f]">— hybrid retrieval, reranked</span></h2>
              <div className="space-y-3">
                {res.results.passages.map((p:any,i:number)=>(
                  <div key={i} className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4">
                    <div className="text-xs font-mono text-[#8e8e8e] break-all">{p.source ? p.source.split("/").pop() : "Unknown"} • p. {p.page} {p.section? `• ${p.section}`:""}</div>
                    <div className="text-sm leading-relaxed mt-2 whitespace-pre-wrap break-words text-[#ececec]">{p.text}</div>
                  </div>
                ))}
                {res.results.passages.length===0 && <div className="rounded-2xl border border-dashed border-[#2f2f2f] bg-[#0a0a0a] p-6 text-sm text-[#8e8e8e]">No passages — either the query is too short or the vector store is empty. Upload documents first.</div>}
              </div>
              {res.filters && Object.keys(res.filters).length>0 && (
                <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 text-xs">
                  <div className="font-semibold text-white">Active structured filters</div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-[#8e8e8e] break-all">{JSON.stringify(res.filters, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
