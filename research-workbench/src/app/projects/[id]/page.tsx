"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import { api } from "@/lib/api";

export default function ProjectDetail(){
  const { id } = useParams<{id:string}>();
  const [proj, setProj] = useState<any>(null);
  const [q, setQ] = useState("");
  const [ans, setAns] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [evidenceClaim, setEvidenceClaim] = useState("");
  const [evidenceQuote, setEvidenceQuote] = useState("");
  const [claims, setClaims] = useState<any[]>([]);
  const [newClaim, setNewClaim] = useState("");
  const [citFor, setCitFor] = useState<string | null>(null);
  const [citDoc, setCitDoc] = useState<string | null>(null);
  const [citSupport, setCitSupport] = useState("supports");
  const [citLocator, setCitLocator] = useState("");

  const [generatingInfo, setGeneratingInfo] = useState<any>(null);

  const load = async()=>{
    const p = await api.getProject(String(id));
    setProj(p);
    api.projectClaims(String(id)).then(setClaims).catch(()=>{});
  };
  useEffect(()=>{ if(id) load(); },[id]);

  // Persistent generating indicator (survives refresh)
  useEffect(()=>{
    if(!id) return;
    const key = `generating:${id}`;
    const raw = localStorage.getItem(key);
    if(raw){
      try{ const v = JSON.parse(raw); if(Date.now() - v.at < 5*60*1000) setGeneratingInfo(v); else localStorage.removeItem(key); } catch{}
    }
    const iv = setInterval(()=>{
      const r = localStorage.getItem(key);
      if(!r){ setGeneratingInfo(null); return; }
      try{
        const v = JSON.parse(r);
        // if the query now appears in trail, clear generating
        const q = v.query;
        api.getProject(String(id)).then(p=>{
          const found = (p.queries||[]).some((qq:any)=> qq.query === q);
          if(found){ localStorage.removeItem(key); setGeneratingInfo(null); setProj(p); }
        }).catch(()=>{});
        setGeneratingInfo(v);
      } catch{}
    }, 2000);
    return ()=> clearInterval(iv);
  },[id]);

  const ask = async()=>{
    if(!q.trim()) return;
    const query = q;
    const key = `generating:${id}`;
    localStorage.setItem(key, JSON.stringify({ query, at: Date.now() }));
    setGeneratingInfo({ query, at: Date.now() });
    setLoading(true);
    try{
      const r = await api.ask({ query, document_ids: (proj.documents||[]).map((d:any)=>d.id), project_id: String(id) });
      setAns(r);
      // keep trail claimed-able even after refresh: reload will fetch sources_json
      load();
    } catch(e:any){ setAns({ answer:"Error: "+e.message }); }
    finally{
      localStorage.removeItem(key);
      setGeneratingInfo(null);
      setLoading(false);
    }
  };

  const addEvidence = async()=>{
    if(!evidenceClaim.trim() || !evidenceQuote.trim()) return;
    await api.addProjectEvidence(String(id), evidenceClaim, evidenceQuote);
    setEvidenceClaim(""); setEvidenceQuote(""); load();
  };

  const addClaim = async()=>{
    if(!newClaim.trim()) return;
    await api.createClaim({ project_id: String(id), text: newClaim });
    setNewClaim("");
    api.projectClaims(String(id)).then(setClaims).catch(()=>{});
  };

  const linkEvidence = async(cid: string)=>{
    if(!citDoc) return;
    await api.claimAddCitation(cid, { document_id: citDoc, support: citSupport, locator: citLocator || null });
    setCitFor(null); setCitDoc(null); setCitLocator(""); setCitSupport("supports");
    api.projectClaims(String(id)).then(setClaims).catch(()=>{});
  };

  if(!proj) return <div className="p-6 text-sm text-[#8e8e8e] bg-black min-h-screen">Loading…</div>;

  const deleteProject = async()=>{
    if(!confirm(`Delete project "${proj.name}"? Its claims and evidence links will be removed (documents stay in Library).`)) return;
    try{ await api.deleteProject(String(id)); window.location.href = "/projects"; } catch(e:any){ alert(e.message); }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar
        title={proj.name}
        subtitle={`${proj.documents?.length||0} sources • ${proj.description || ""}`}
        actions={
          <button onClick={deleteProject} className="rounded-xl border border-red-900/50 bg-[#171717] px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/30">Delete project</button>
        }
      />
      <div className="px-4 lg:px-6 py-6 space-y-6 max-w-6xl w-full mx-auto">
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Ask this project (scoped retrieval)</div>
              {(loading || generatingInfo) && (
                <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/20 px-3 py-2 flex items-center gap-2 text-xs text-amber-300">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  <span className="flex-1">Model is generating answer for: <b className="text-amber-200">“{(generatingInfo?.query || q).slice(0,80)}”</b> — this stays visible if you refresh or switch pages until the answer appears in the trail below.</span>
                  {generatingInfo && <span className="font-mono text-[11px] text-amber-400/70 shrink-0">{Math.max(0, Math.floor((Date.now() - generatingInfo.at)/1000))}s</span>}
                  <button onClick={()=>{
                    const k=`generating:${id}`;
                    localStorage.removeItem(k);
                    setGeneratingInfo(null);
                  }} className="ml-1 text-amber-400/70 hover:text-amber-200 shrink-0">✕</button>
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3 mt-3">
                <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=> e.key==="Enter" && ask()} placeholder="Ask only the project's documents…" disabled={!!generatingInfo || loading} className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-4 py-3 text-sm text-white placeholder:text-[#5f5f5f] disabled:opacity-50" />
                <button onClick={ask} disabled={loading || !!generatingInfo} className="rounded-xl bg-white text-black px-6 py-3 text-sm font-medium disabled:opacity-50">{loading || generatingInfo ? "Generating…" : "Ask"}</button>
              </div>
              {ans && <div className="mt-4 rounded-xl border border-[#2f2f2f] bg-[#171717] p-4 text-sm whitespace-pre-wrap leading-relaxed text-[#ececec]">{ans.answer}</div>}
              {ans?.sources && <div className="mt-3 space-y-2">{ans.sources.map((s:any,i:number)=><div key={i} className="rounded-xl border border-[#2f2f2f] bg-black p-3"><div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation}</div><div className="text-sm mt-1 text-[#ececec] break-words">{s.snippet}</div><button onClick={()=>{ setEvidenceClaim(s.snippet.slice(0,120)); setEvidenceQuote(s.snippet); }} className="mt-2 text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-white hover:bg-[#2f2f2f]">Add to evidence ↘</button></div>)}</div>}
            </div>

            <div id="evidence-cards" className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Evidence cards</div>
              <div className="text-xs text-[#8e8e8e]">When the assistant makes a claim, click “Add to research” to store a structured evidence item.</div>
              <div className="mt-3 grid gap-2">
                <input value={evidenceClaim} onChange={e=>setEvidenceClaim(e.target.value)} placeholder="Claim" className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
                <textarea value={evidenceQuote} onChange={e=>setEvidenceQuote(e.target.value)} placeholder="Quoted evidence" rows={2} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
                <button onClick={addEvidence} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium self-start">Add evidence</button>
              </div>
              <div className="mt-4 space-y-2">
                {(proj.evidence||[]).map((ev:any)=><div key={ev.id} className="rounded-xl border border-[#2f2f2f] bg-black p-3"><div className="text-sm font-medium text-white break-words">{ev.claim}</div><div className="text-sm mt-1 italic text-[#b4b4b4] break-words">“{ev.quoted_evidence}”</div><div className="text-xs text-[#5f5f5f] mt-1">{ev.location || ""} • {new Date(ev.created_at).toLocaleString()}</div></div>)}
                {(proj.evidence||[]).length===0 && <div className="text-sm text-[#8e8e8e]">No evidence yet.</div>}
              </div>
            </div>

            <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Claims — evidence graph</div>
              <div className="text-xs text-[#8e8e8e] mt-1">Structured Claim → Evidence links with an explicit relationship type (supports / contradicts / mentions).</div>
              <div className="mt-3 flex gap-2">
                <input value={newClaim} onChange={e=>setNewClaim(e.target.value)} onKeyDown={e=> e.key==="Enter" && addClaim()} placeholder="Add a claim…" className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
                <button onClick={addClaim} disabled={!newClaim.trim()} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-40">Add claim</button>
              </div>
              <div className="mt-4 space-y-3">
                {claims.map(claim=>(
                  <div key={claim.id} className="rounded-xl border border-[#2f2f2f] bg-black p-3">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 text-sm font-medium text-white break-words">{claim.text}</div>
                      <button onClick={async()=>{ await api.deleteClaim(claim.id); api.projectClaims(String(id)).then(setClaims).catch(()=>{}); }} className="text-[#5f5f5f] hover:text-red-400 text-xs">✕</button>
                    </div>
                    {(["supports","contradicts","mentions"] as const).map(kind=>(
                      <div key={kind} className="mt-2">
                        {((claim.evidence||{})[kind]||[]).map((ev:any,i:number)=>(
                          <div key={i} className="ml-3 flex items-center gap-2 text-xs py-0.5">
                            <span className={`rounded-full px-2 py-0.5 border ${kind==="supports" ? "bg-emerald-950 border-emerald-800 text-emerald-300" : kind==="contradicts" ? "bg-red-950 border-red-900 text-red-300" : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e]"}`}>{kind}</span>
                            <span className="text-[#ececec] truncate">{ev.title}</span>
                            {ev.locator && <span className="text-[#5f5f5f]">{ev.locator}</span>}
                          </div>
                        ))}
                      </div>
                    ))}
                    {citFor===claim.id ? (
                      <div className="mt-2 flex flex-wrap gap-2 items-center">
                        <select value={citDoc ?? ""} onChange={e=>setCitDoc(e.target.value)} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-2 py-1.5 text-xs text-white">
                          <option value="">Pick source…</option>
                          {(proj.documents||[]).map((d:any)=> <option key={d.id} value={d.id} className="bg-[#171717]">{d.title.slice(0,50)}</option>)}
                        </select>
                        <select value={citSupport} onChange={e=>setCitSupport(e.target.value)} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-2 py-1.5 text-xs text-white">
                          <option value="supports">supports</option>
                          <option value="contradicts">contradicts</option>
                          <option value="mentions">mentions</option>
                        </select>
                        <input value={citLocator} onChange={e=>setCitLocator(e.target.value)} placeholder="p.17" className="w-20 rounded-xl border border-[#2f2f2f] bg-[#171717] px-2 py-1.5 text-xs text-white" />
                        <button onClick={()=>linkEvidence(claim.id)} className="rounded-xl bg-white text-black px-3 py-1.5 text-xs font-medium">Link</button>
                        <button onClick={()=>setCitFor(null)} className="text-xs text-[#8e8e8e]">cancel</button>
                      </div>
                    ) : (
                      <button onClick={()=>setCitFor(claim.id)} className="mt-2 text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-white hover:bg-[#2f2f2f]">+ link evidence</button>
                    )}
                  </div>
                ))}
                {claims.length===0 && <div className="text-sm text-[#8e8e8e]">No claims yet — add a claim and link the sources that support or contradict it.</div>}
              </div>
            </div>

            <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Research trail (this project)</div>
              <div className="text-xs text-[#8e8e8e] mt-1">Every answer is saved here even if you refresh mid-generation — expand to claim evidence.</div>
              <div className="space-y-2 mt-3">
                {(proj.queries||[]).map((qu:any)=>{
                  let trailSources: any[] = [];
                  try{
                    const parsed = qu.sources_json ? (typeof qu.sources_json === "string" ? JSON.parse(qu.sources_json) : qu.sources_json) : null;
                    trailSources = parsed?.sources || parsed || qu.sources || [];
                    if(!Array.isArray(trailSources)) trailSources = [];
                  } catch{ trailSources = qu.sources || []; }
                  return (
                    <details key={qu.id} className="rounded-xl border border-[#2f2f2f] bg-[#171717] group">
                      <summary className="px-3 py-2 text-sm cursor-pointer text-white list-none flex items-center gap-2">
                        <span className="flex-1 truncate">{qu.query}</span>
                        {trailSources.length>0 && <span className="shrink-0 rounded-full bg-[#212121] border border-[#2f2f2f] px-2 py-0.5 text-xs text-[#8e8e8e]">{trailSources.length} sources</span>}
                        <span className="text-[#5f5f5f] group-open:rotate-90 transition-transform">▸</span>
                      </summary>
                      <div className="px-3 pb-3 space-y-3 border-t border-[#1a1a1a] pt-3">
                        <pre className="text-xs whitespace-pre-wrap font-mono text-[#8e8e8e] break-all">{qu.answer?.slice(0,3000)}</pre>
                        {trailSources.length>0 && (
                          <details className="rounded-xl bg-black border border-[#2f2f2f] overflow-hidden">
                            <summary className="px-3 py-2 text-xs font-medium text-[#8e8e8e] cursor-pointer list-none flex items-center gap-2">
                              <span>▸ Sources</span>
                              <span className="rounded-full bg-[#212121] border border-[#2f2f2f] px-1.5 py-0.5 text-[11px]">{trailSources.length}</span>
                              <span className="text-[#5f5f5f]">— claim evidence even after refresh</span>
                            </summary>
                            <div className="px-3 pb-3 space-y-2 pt-2">
                              {trailSources.slice(0,6).map((s:any,i:number)=>(
                                <div key={i} className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3">
                                  <div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation || s.metadata?.source || `Source ${i+1}`}</div>
                                  <div className="text-sm mt-1 text-[#ececec] break-words line-clamp-3">{s.snippet || s.text || ""}</div>
                                  <button onClick={()=>{
                                    setEvidenceClaim(s.snippet?.slice(0,120) || qu.query.slice(0,120));
                                    setEvidenceQuote(s.snippet || s.text || "");
                                    document.getElementById("evidence-cards")?.scrollIntoView({behavior:"smooth"});
                                  }} className="mt-2 text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-white hover:bg-[#2f2f2f]">Add to evidence ↘</button>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    </details>
                  );
                })}
                {(proj.queries||[]).length===0 && <div className="text-sm text-[#8e8e8e]">No queries yet.</div>}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Sources</div>
              <div className="space-y-2 mt-3">
                {(proj.documents||[]).map((d:any)=><div key={d.id} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2"><div className="text-sm font-medium truncate text-white">{d.title}</div><div className="text-xs text-[#8e8e8e] truncate">{d.original_filename}</div></div>)}
                {(proj.documents||[]).length===0 && <div className="text-sm text-[#8e8e8e]">No sources — add documents from Library.</div>}
              </div>
            </div>
            <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
              <div className="text-sm font-semibold text-white">Notes</div>
              <div className="text-xs text-[#8e8e8e]">Markdown notes with Attach source / Attach evidence / Ask AI</div>
              <textarea placeholder="Write markdown notes…" rows={6} className="mt-3 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
              <button className="mt-2 rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Save note</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
