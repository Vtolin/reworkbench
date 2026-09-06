"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";

interface Project {
  id: string;
  name: string;
  description: string;
}
interface Claim {
  id: string;
  text: string;
  status: string;
}

export default function ProjectsPage() {
  const { workspace } = useSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [claimText, setClaimText] = useState("");

  const load = async () => {
    if (!workspace) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("research_projects")
      .select("id, name, description")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false });
    setProjects((data ?? []) as Project[]);
  };

  const loadClaims = async (projectId: string) => {
    const supabase = createClient();
    const { data } = await supabase.from("claims").select("id, text, status").eq("project_id", projectId);
    setClaims((data ?? []) as Claim[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const create = async () => {
    if (!workspace || !name.trim()) return;
    const supabase = createClient();
    await supabase.from("research_projects").insert({ workspace_id: workspace.id, name });
    setName("");
    load();
  };

  const open = async (id: string) => {
    setActiveId(id);
    await loadClaims(id);
  };

  const addClaim = async () => {
    if (!workspace || !activeId || !claimText.trim()) return;
    const supabase = createClient();
    await supabase.from("claims").insert({ workspace_id: workspace.id, project_id: activeId, text: claimText });
    setClaimText("");
    loadClaims(activeId);
  };

  return (
    <main className="mx-auto flex max-w-6xl gap-6 px-6 py-12">
      <aside className="w-64 shrink-0">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project…"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <button onClick={create} className="rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-black">
            Add
          </button>
        </div>
        <ul className="mt-4 space-y-1">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => open(p.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm ${p.id === activeId ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex-1">
        {!activeId ? (
          <p className="text-sm text-neutral-500">Select or create a project.</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-neutral-100">Claims</h1>
            <div className="mt-3 flex gap-2">
              <input
                value={claimText}
                onChange={(e) => setClaimText(e.target.value)}
                placeholder="Add a claim…"
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
              <button onClick={addClaim} className="rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-black">
                Add
              </button>
            </div>
            <ul className="mt-4 space-y-2">
              {claims.map((c) => (
                <li key={c.id} className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-100">
                  {c.text} <span className="ml-2 text-xs text-neutral-500">{c.status}</span>
                </li>
              ))}
              {claims.length === 0 && <li className="text-sm text-neutral-500">No claims yet.</li>}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
