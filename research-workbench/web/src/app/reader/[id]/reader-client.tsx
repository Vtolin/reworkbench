"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Citation-aware reader: PDF from Supabase Storage + highlights/notes →
// annotations (tags, project/claim links included).
export function ReaderClient({ documentId }: { documentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [page, setPage] = useState(1);
  const [annotations, setAnnotations] = useState<Array<{ id: string; note: string | null; page: number }>>([]);

  useEffect(() => {
    const run = async () => {
      const supabase = createClient();
      const { data: doc } = await supabase.from("documents").select("storage_path").eq("id", documentId).single();
      const path = (doc as { storage_path?: string } | null)?.storage_path;
      if (path) {
        const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
        setUrl(data?.signedUrl ?? null);
      }
      const { data: anns } = await supabase
        .from("annotations")
        .select("id, note, page")
        .eq("document_id", documentId)
        .order("created_at");
      setAnnotations((anns ?? []) as Array<{ id: string; note: string | null; page: number }>);
    };
    run();
  }, [documentId]);

  const saveNote = async () => {
    if (!note.trim()) return;
    const supabase = createClient();
    const { data: doc } = await supabase.from("documents").select("workspace_id").eq("id", documentId).single();
    await supabase.from("annotations").insert({
      workspace_id: (doc as { workspace_id: string }).workspace_id,
      document_id: documentId,
      page,
      note,
      category: "note",
    });
    setNote("");
    const { data: anns } = await supabase
      .from("annotations")
      .select("id, note, page")
      .eq("document_id", documentId)
      .order("created_at");
    setAnnotations((anns ?? []) as Array<{ id: string; note: string | null; page: number }>);
  };

  return (
    <main className="mx-auto flex max-w-6xl gap-6 px-6 py-12">
      <section className="flex-1">
        {url ? (
          <iframe src={url} className="h-[80vh] w-full rounded border border-neutral-800" title="Document" />
        ) : (
          <p className="text-sm text-neutral-500">Loading document…</p>
        )}
      </section>
      <aside className="w-72 shrink-0">
        <h1 className="font-medium text-neutral-100">Notes</h1>
        <div className="mt-2 flex gap-2">
          <input
            type="number"
            min={1}
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
            className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note…"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-1 text-sm"
          />
          <button onClick={saveNote} className="rounded bg-neutral-100 px-3 py-1 text-sm font-medium text-black">
            Save
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {annotations.map((a) => (
            <li key={a.id} className="rounded border border-neutral-800 p-2 text-sm text-neutral-200">
              <span className="text-xs text-neutral-500">p.{a.page}</span> {a.note}
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}
