"use client";
import Topbar from "@/components/Topbar";
import UploadFlow from "@/components/UploadFlow";
import { useState } from "react";

export default function UploadPage(){
  const [key, setKey] = useState(0);
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Upload & Ingest" subtitle="Pipeline: UPLOAD → HASH → DUPLICATE CHECK → PARSE → METADATA → CLASSIFICATION → CONFIRM → INDEX. AI proposes, human confirms — then an admin approves." />
      <div className="px-4 lg:px-6 py-6 max-w-4xl w-full mx-auto">
        <UploadFlow key={key} onDone={()=>{}} />
        <div className="mt-6 rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-5">
          <div className="text-sm font-semibold text-white">What happens after you click Accept?</div>
          <ol className="mt-2 text-sm text-[#b4b4b4] list-decimal ml-5 space-y-1 leading-relaxed">
            <li>File is uploaded to <span className="font-mono text-white">Supabase Storage (documents bucket)</span>, content-addressed by SHA-256</li>
            <li>Document record created in <span className="font-mono text-white">Postgres → documents</span> with status <span className="font-mono text-white">pending</span></li>
            <li>Text is extracted in your browser, chunked (≈4700 chars / 880 overlap), and embedded via <span className="font-mono text-white">nomic-embed-text</span> (local Ollama) or your cloud embedding API</li>
            <li>Chunks + vectors land in <span className="font-mono text-white">document_chunks / document_embeddings</span> (pgvector) for hybrid FTS + vector retrieval</li>
            <li>An admin approves the upload — only then does it enter the shared library</li>
          </ol>
          <div className="mt-3 text-xs text-[#5f5f5f]">Confidence thresholds: ≥0.85 auto-suggest collection, 0.60–0.84 ask to confirm, &lt;0.60 suggest creating new. Nothing is shared until confirmation + approval.</div>
        </div>
      </div>
    </div>
  );
}
