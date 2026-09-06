"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import { api } from "@/lib/api";

export default function ReaderPage(){
  const { id } = useParams<{id:string}>();
  const [doc, setDoc] = useState<any>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [note, setNote] = useState("");
  const [highlights, setHighlights] = useState<any[]>([]);

  useEffect(()=>{ if(!id) return; api.getDocument(Number(id)).then(d=>{ setDoc(d); setPdfUrl(`${process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"}/api/library/documents/${id}/file`); }).catch(()=>{}); },[id]);
  useEffect(()=>{ if(id) api.annotations(Number(id)).then(setHighlights).catch(()=>{}); },[id]);

  const addHighlight = async(color="#facc15")=>{
    if(!selection.trim()) return;
    await api.createAnnotation(Number(id), { page: 1, selected_text: selection, note, color });
    setSelection(""); setNote(""); const h=await api.annotations(Number(id)); setHighlights(h);
  };
  const askSelection = async()=>{
    if(!selection.trim()) return;
    const r = await api.ask({ query: `Explain: "${selection}"`, document_ids: [Number(id)] });
    alert(r.answer.slice(0,1200));
  };

  if(!doc) return <div className="p-6 text-sm text-[#8e8e8e] bg-black min-h-screen">Loading…</div>;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title={doc.title} subtitle={`${doc.original_filename} • ${doc.page_count||"?"} pages — highlight, annotate, and send to evidence`} />
      <div className="flex flex-1 min-h-0 flex-col lg:flex-row">
        <div className="flex-1 bg-black p-4 overflow-auto">
          <div className="mx-auto max-w-4xl bg-[#0a0a0a] rounded-2xl border border-[#2f2f2f] overflow-hidden" style={{minHeight: "50vh"}}>
            {pdfUrl ? (
              <iframe src={pdfUrl} className="w-full" style={{height:"70vh"}} title="PDF reader" />
            ) : <div className="p-10 text-sm text-[#8e8e8e]">No file available</div>}
          </div>
          <div className="mx-auto max-w-4xl mt-4 rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4">
            <div className="text-sm font-semibold text-white">Text selection → actions</div>
            <textarea value={selection} onChange={e=>setSelection(e.target.value)} placeholder="Select text in the PDF above, then paste here…" rows={3} className="mt-2 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
            <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Note attached to highlight (optional)" className="mt-2 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]" />
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={()=>addHighlight("#facc15")} className="rounded-xl bg-[#facc15] text-black px-4 py-2 text-sm font-medium">Highlight yellow</button>
              <button onClick={()=>addHighlight("#86efac")} className="rounded-xl bg-[#86efac] text-black px-4 py-2 text-sm font-medium">Highlight green</button>
              <button onClick={()=>addHighlight("#93c5fd")} className="rounded-xl bg-[#93c5fd] text-black px-4 py-2 text-sm font-medium">Highlight blue</button>
              <button onClick={askSelection} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium">Ask AI about selection</button>
            </div>
          </div>
        </div>
        <div className="w-full lg:w-[360px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#2f2f2f] bg-[#0a0a0a] flex flex-col max-h-[50vh] lg:max-h-none">
          <div className="p-4 border-b border-[#2f2f2f]">
            <div className="text-sm font-semibold text-white">Highlights & notes</div>
            <div className="text-xs text-[#8e8e8e] break-words">{highlights.length} highlights — stored as structured data in SQLite</div>
          </div>
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {highlights.map(h=>(
              <div key={h.id} className="rounded-xl border p-3" style={{background: h.color+"20", borderColor: "#2f2f2f"}}>
                <div className="text-xs text-[#8e8e8e]">p. {h.page} • {new Date(h.created_at).toLocaleString()}</div>
                <div className="text-sm mt-1 text-white break-words">“{h.selected_text}”</div>
                {h.note && <div className="text-sm mt-1 text-[#ececec] bg-black rounded-lg px-2 py-1 border border-[#2f2f2f] break-words">{h.note}</div>}
                <div className="mt-2 flex gap-1 flex-wrap">
                  <button onClick={async()=>{ const r=await api.ask({ query:`Explain: ${h.selected_text}`, document_ids:[Number(id)] }); alert(r.answer.slice(0,1200)); }} className="text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-2 py-1 text-white">Ask AI</button>
                  <button onClick={()=>alert("Added to evidence (wire to project)")} className="text-xs rounded-full border border-[#2f2f2f] bg-[#212121] px-2 py-1 text-[#8e8e8e]">Add to evidence</button>
                </div>
              </div>
            ))}
            {highlights.length===0 && <div className="text-sm text-[#8e8e8e]">No highlights yet. Make a selection and highlight.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
