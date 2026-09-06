"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useInference } from "@/contexts/InferenceContext";
import { sha256Hex, chunkText, extractPdfTextBrowser } from "@/lib/ingestion/chunking";
import { OllamaProvider } from "@/lib/ai/ollama";

// Upload flow: Storage → extract/chunk/metadata (browser or Vercel) →
// embeddings (local Ollama or cloud API) → Supabase rows.
// Member uploads land in `pending` for admin approval.
export function UploadBox({ onDone }: { onDone?: () => void }) {
  const { workspace, user } = useSession();
  const { settings } = useInference();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    if (!workspace || !user) return;
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const hash = await sha256Hex(buf);
      const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "bin";
      const storagePath = `${workspace.id}/${hash}.${ext}`;
      const supabase = createClient();
      setStatus("Uploading to Storage…");
      const { error: upErr } = await supabase.storage.from("documents").upload(storagePath, file, {
        upsert: true,
        contentType: file.type,
      });
      if (upErr) throw new Error(upErr.message);

      setStatus("Extracting text…");
      let text = "";
      let pageCount: number | null = null;
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const out = await extractPdfTextBrowser(file);
        text = out.text;
        pageCount = out.pageCount;
      } else {
        text = await file.text();
      }
      const chunks = chunkText(text);

      setStatus("Creating document (pending approval)…");
      const { data: doc, error: docErr } = await supabase
        .from("documents")
        .insert({
          workspace_id: workspace.id,
          title: file.name,
          original_filename: file.name,
          storage_path: storagePath,
          file_hash: hash,
          file_size: file.size,
          mime_type: file.type,
          page_count: pageCount,
          ingestion_status: chunks.length ? "ready" : "metadata_only",
          metadata_json: { text_snippet: text.slice(0, 2000) },
          status: "pending",
          uploaded_by: user.id,
        })
        .select("id")
        .single();
      if (docErr || !doc) throw new Error(docErr?.message ?? "Document insert failed");
      const docId = (doc as { id: string }).id;

      if (chunks.length > 0) {
        setStatus(`Embedding ${chunks.length} chunks (${settings.embedMode})…`);
        const { data: rows, error: chunkErr } = await supabase
          .from("document_chunks")
          .insert(
            chunks.map((c) => ({
              workspace_id: workspace.id,
              document_id: docId,
              content: c.content,
              chunk_index: c.chunk_index,
            })),
          )
          .select("id, content");
        if (chunkErr) throw new Error(chunkErr.message);
        // Embed each chunk on the selected path, then store vectors.
        for (const row of (rows ?? []) as Array<{ id: string; content: string }>) {
          let embedding: number[];
          if (settings.embedMode === "local") {
            embedding = await new OllamaProvider().embed(row.content.slice(0, 2000));
          } else {
            const res = await fetch("/api/rag/embed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: row.content.slice(0, 2000), mode: "server" }),
            });
            if (!res.ok) throw new Error("Server embedding failed");
            embedding = ((await res.json()).embedding as number[]) ?? [];
          }
          await supabase.from("document_embeddings").insert({
            chunk_id: row.id,
            embedding,
            model_name: "nomic-embed-text",
          });
        }
      }
      setStatus("Done — awaiting admin approval.");
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-dashed border-neutral-700 p-6 text-center">
      <input
        type="file"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      {status && <p className="mt-2 text-sm text-neutral-300">{status}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
