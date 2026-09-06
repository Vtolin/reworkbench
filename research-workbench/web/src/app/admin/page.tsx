"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { MAX_ALLOWED_MEMBERS } from "@/lib/permissions/constants";

interface Member {
  id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

// Admin dashboard: members, member limit (bounded by MAX_ALLOWED_MEMBERS=10),
// kick (soft-remove + session invalidation). Server re-enforces everything.
export default function AdminPage() {
  const { workspace, user } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [limit, setLimit] = useState(10);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!workspace) return;
    const res = await fetch(`/api/workspaces/members?workspaceId=${workspace.id}`);
    const data = await res.json();
    if (res.ok) {
      setMembers(data.members);
      setLimit(workspace.member_limit);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  if (workspace && workspace.role !== "admin") {
    return <main className="p-8 text-sm text-red-400">Admin only.</main>;
  }

  const saveLimit = async () => {
    if (!workspace) return;
    setError(null);
    const res = await fetch("/api/workspaces/limit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, member_limit: limit }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error);
    else setLimit(data.member_limit);
  };

  const kick = async (userId: string) => {
    if (!workspace || !confirm("Remove this member? Their sessions will be invalidated.")) return;
    const res = await fetch("/api/workspaces/kick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, userId }),
    });
    if (res.ok) load();
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-100">Admin</h1>
      <p className="mt-1 text-sm text-neutral-400">
        {workspace?.name} · absolute ceiling MAX_ALLOWED_MEMBERS = {MAX_ALLOWED_MEMBERS}
      </p>
      <section className="mt-6 rounded border border-neutral-800 p-4">
        <h2 className="font-medium text-neutral-100">Member limit (soft, ≤ {MAX_ALLOWED_MEMBERS})</h2>
        <div className="mt-2 flex gap-2">
          <input
            type="number"
            min={1}
            max={MAX_ALLOWED_MEMBERS}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-24 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <button onClick={saveLimit} className="rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-black">
            Save
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </section>
      <section className="mt-6 rounded border border-neutral-800 p-4">
        <h2 className="font-medium text-neutral-100">Members ({members.length})</h2>
        <ul className="mt-2 space-y-2">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 text-sm text-neutral-300">
              <span className="font-mono text-xs text-neutral-500">{m.user_id.slice(0, 8)}</span>
              <span>{m.role}</span>
              {m.user_id !== user?.id && (
                <button onClick={() => kick(m.user_id)} className="ml-auto text-red-400 underline">
                  Kick
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
