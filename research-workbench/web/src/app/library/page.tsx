"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { UploadBox } from "@/components/UploadBox";

interface Doc {
  id: string;
  title: string;
  year: number | null;
  status: string;
  document_type: string | null;
}

export default function LibraryPage() {
  const { workspace } = useSession();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [filter, setFilter] = useState<"approved" | "pending" | "all">("approved");
  const [q, setQ] = useState("");

  const load = async () => {
    if (!workspace) return;
    const supabase = createClient();
    let query = supabase
      .from("documents")
      .select("id, title, year, status, document_type")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (filter !== "all") query = query.eq("status", filter);
    if (q) query = query.ilike("title", `%${q}%`);
    const { data } = await query;
    setDocs((data ?? []) as Doc[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, filter]);

  const approve = async (id: string, decision: "approved" | "rejected") => {
    await fetch("/api/documents/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: id, decision }),
    });
    load();
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-100">Library</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Approved documents are visible to everyone in the workspace. Member uploads wait in{" "}
        <span className="text-neutral-200">pending</span> for admin approval.
      </p>
      <div className="mt-4 flex gap-2 text-sm">
        {(["approved", "pending", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded border px-3 py-1 ${filter === f ? "border-neutral-100 text-neutral-100" : "border-neutral-800 text-neutral-400"}`}
          >
            {f}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Filter by title…"
          className="ml-auto rounded border border-neutral-800 bg-neutral-950 px-3 py-1 text-sm"
        />
        <button onClick={load} className="rounded border border-neutral-800 px-3 py-1 text-neutral-200">
          Search
        </button>
      </div>
      <div className="mt-6 overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-950 text-left text-neutral-400">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Year</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-neutral-800">
                <td className="px-4 py-2 text-neutral-100">{d.title || "(untitled)"}</td>
                <td className="px-4 py-2 text-neutral-400">{d.year ?? "—"}</td>
                <td className="px-4 py-2 text-neutral-400">{d.document_type ?? "—"}</td>
                <td className="px-4 py-2 text-neutral-400">{d.status}</td>
                <td className="px-4 py-2 text-right">
                  {workspace?.role === "admin" && d.status === "pending" && (
                    <>
                      <button onClick={() => approve(d.id, "approved")} className="mr-2 text-emerald-400 underline">
                        Approve
                      </button>
                      <button onClick={() => approve(d.id, "rejected")} className="text-red-400 underline">
                        Reject
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-neutral-500">
                  No documents.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-8">
        <h2 className="font-medium text-neutral-100">Upload (goes to pending approval)</h2>
        <div className="mt-2">
          <UploadBox onDone={load} />
        </div>
      </div>
    </main>
  );
}
