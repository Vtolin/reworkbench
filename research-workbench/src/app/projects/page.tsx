"use client";
import { useEffect, useState } from "react";
import Topbar from "@/components/Topbar";
import { api } from "@/lib/api";
import Link from "next/link";

export default function ProjectsPage(){
  const [projects, setProjects] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const load = ()=>{ api.projects().then(setProjects).catch(()=>{}); api.listDocuments({}).then(r=>setDocs(r.documents)).catch(()=>{}); };
  useEffect(()=>{ load(); },[]);

  const create = async()=>{
    if(!name.trim()) return;
    await api.createProject({ name, description: desc, document_ids: selected });
    setName(""); setDesc(""); setSelected([]); load();
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Research Projects" subtitle="Scoped workspaces: name a project, pick a source subset, ask only that subset, collect evidence cards" />
      <div className="px-4 lg:px-6 py-6 max-w-5xl w-full mx-auto space-y-6">
        <div className="rounded-2xl border border-[#1a1a1a] bg-[#0a0a0a]/50 p-3 flex items-start gap-2 text-xs leading-relaxed text-[#8e8e8e]">
          <span className="mt-0.5">ⓘ</span>
          <span><b className="text-[#ececec]">How to use Projects:</b> Create a project (e.g. "Thesis Ch.2") → pick only the sources you need → <b className="text-[#ececec]">Ask</b> stays scoped to those sources → highlight any answer snippet → <b className="text-[#ececec]">Add to evidence</b> or add a <b className="text-[#ececec]">Claim</b> and link sources as <i>supports/contradicts/mentions</i>. Delete with ✕ (top-right of card or inside project).</span>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">New project</div>
          <div className="grid gap-3 mt-3 grid-cols-1 md:grid-cols-2">
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. AI and Indonesian Education" className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f]" />
            <input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Description (optional)" className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f]" />
          </div>
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#8e8e8e]">Sources in this project</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {docs.map(d=>{
                const on = selected.includes(d.id);
                return <button key={d.id} onClick={()=> setSelected(on? selected.filter(x=>x!==d.id):[...selected, d.id])} className={`rounded-full px-3 py-1.5 text-xs border ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>{d.original_filename}</button>
              })}
            </div>
          </div>
          <button onClick={create} className="mt-4 rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium">Create project</button>
        </div>

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
          {projects.map(p=>(
            <div key={p.id} className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-5 hover:border-[#404040] transition relative group">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="font-medium text-white pr-8">{p.name}</div>
                <div className="text-sm text-[#8e8e8e] mt-1 line-clamp-2 break-words">{p.description || "No description"}</div>
                <div className="text-xs text-[#5f5f5f] mt-3">{p.document_count} sources • {new Date(p.updated_at).toLocaleDateString()}</div>
              </Link>
              <button
                onClick={async (e)=>{
                  e.preventDefault();
                  if(!confirm(`Delete project "${p.name}"? This removes its claims/evidence links (documents stay in Library).`)) return;
                  try{ await api.deleteProject(p.id); load(); } catch(err:any){ alert(err.message); }
                }}
                className="absolute top-3 right-3 h-7 w-7 grid place-items-center rounded-full bg-[#171717] border border-[#2f2f2f] text-[#8e8e8e] hover:text-red-400 hover:border-red-900/50 hover:bg-red-950/30 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                title="Delete project"
                aria-label="Delete project"
              >✕</button>
            </div>
          ))}
          {projects.length===0 && <div className="rounded-2xl border border-dashed border-[#2f2f2f] bg-[#0a0a0a] p-10 text-center text-sm text-[#8e8e8e] md:col-span-2">No projects yet. Create one above to scope a thesis/assignment.</div>}
        </div>
      </div>
    </div>
  );
}
