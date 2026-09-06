"use client";
import Topbar from "@/components/Topbar";
import UploadFlow from "@/components/UploadFlow";
import { useState } from "react";

export default function UploadPage(){
  const [key, setKey] = useState(0);
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Upload & Ingest" subtitle="Pipeline: UPLOAD → VALIDATION → HASH → DUPLICATE CHECK → PARSE → METADATA → CLASSIFICATION → CONFIRM → INDEX. AI proposes, human confirms." />
      <div className="px-4 lg:px-6 py-6 max-w-4xl w-full mx-auto">
        <UploadFlow key={key} onDone={()=>{}} />
        <div className="mt-6 rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-5">
          <div className="text-sm font-semibold text-white">What happens after you click Accept?</div>
          <ol className="mt-2 text-sm text-[#b4b4b4] list-decimal ml-5 space-y-1 leading-relaxed">
            <li>File is moved to <span className="font-mono text-white">research_workbench/data/documents/ab/cd/&lt;sha256&gt;.pdf</span> (content-addressed)</li>
            <li>DB record created in <span className="font-mono text-white">library.db → documents</span></li>
            <li>Text is parsed (PyMuPDF heading detection + multi-column reordering), chunked, pinpoint-tagged, and embedded via <span className="font-mono text-white">nomic-embed-text</span></li>
            <li>Indexed into Chroma (<span className="font-mono text-white">chroma_db/</span>) and BM25 refreshed</li>
            <li>Per-file progress would show: Parsed → Metadata → Classified → Organized → Embedding → Ready</li>
          </ol>
          <div className="mt-3 text-xs text-[#5f5f5f]">Confidence thresholds (configurable in Settings): ≥0.85 auto-suggest collection, 0.60–0.84 ask to confirm, &lt;0.60 suggest creating new. Nothing moves until confirmation.</div>
        </div>
      </div>
    </div>
  );
}
