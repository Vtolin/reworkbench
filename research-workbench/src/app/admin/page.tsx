"use client";

import { useEffect, useState } from "react";
import Topbar from "@/components/Topbar";
import { useSession } from "@/contexts/SessionContext";
import { MAX_ALLOWED_MEMBERS } from "@/lib/permissions/constants";

interface Member {
  id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

interface PendingDoc {
  id: string;
  title: string;
  original_filename: string;
  created_at: string;
}

// Admin dashboard: members, member limit (bounded by MAX_ALLOWED_MEMBERS=10),
// kick (soft-remove + session invalidation), upload approval queue.
// Server re-enforces everything via RLS + routes.
export default function AdminPage() {
  const { workspace, user } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [limit, setLimit] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [delRequests, setDelRequests] = useState<Array<{ id: string; chat_id: string | null; chat_title?: string; requested_by: string; created_at: string }>>([]);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    if (!workspace) return;
    const res = await fetch(`/api/workspaces/members?workspaceId=${workspace.id}`);
    const data = await res.json();
    if (res.ok) {
      setMembers(data.members);
      setLimit(workspace.member_limit);
    }
    try {
      const { api } = await import("@/lib/api");
      const r = await api.listDocuments({}) as { documents: Array<PendingDoc & { status: string }> };
      setPending(r.documents.filter((d) => d.status === "pending"));
    } catch {
      /* ignore */
    }
    try {
      const { listDeletionRequests } = await import("@/lib/wb/publish");
      setDelRequests(await listDeletionRequests());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Live refresh: a member joining (or being kicked) while this page is open
  // shows up immediately instead of waiting for a manual reload.
  useEffect(() => {
    if (!workspace) return;
    let channel: { unsubscribe: () => void } | null = null;
    (async () => {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      channel = supabase
        .channel(`admin-members:${workspace.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "workspace_members", filter: `workspace_id=eq.${workspace.id}` },
          () => load(),
        )
        .subscribe() as unknown as { unsubscribe: () => void };
    })();
    return () => { channel?.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  if (workspace && workspace.role !== "admin") {
    return (
      <div className="flex-1 min-w-0 flex flex-col bg-black">
        <Topbar title="Admin" subtitle="Workspace administration" />
        <div className="p-6 text-sm text-red-400">Admin only.</div>
      </div>
    );
  }

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(null), 3000); };

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
    else {
      setLimit(data.member_limit);
      flash("Member limit saved");
    }
  };

  const kick = async (userId: string) => {
    if (!workspace || !confirm("Remove this member? Their sessions will be invalidated.")) return;
    const res = await fetch("/api/workspaces/kick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, userId }),
    });
    if (res.ok) {
      load();
      flash("Member removed");
    }
  };

  const decide = async (documentId: string, decision: "approved" | "rejected") => {
    const res = await fetch("/api/documents/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, decision }),
    });
    if (res.ok) {
      load();
      flash(decision === "approved" ? "Approved into the shared library" : "Rejected");
    }
  };

  const decideDeletion = async (requestId: string, decision: "approved" | "rejected") => {
    if (!confirm(decision === "approved" ? "Approve deletion? The shared chat and its messages will be removed." : "Reject this deletion request?")) return;
    try {
      const { decideDeletionRequest } = await import("@/lib/wb/publish");
      await decideDeletionRequest(requestId, decision);
      load();
      flash(decision === "approved" ? "Shared chat deleted" : "Deletion request rejected");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Decision failed");
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Admin" subtitle={`${workspace?.name ?? ""} • absolute ceiling MAX_ALLOWED_MEMBERS = ${MAX_ALLOWED_MEMBERS}`} />
      <div className="px-4 lg:px-6 py-6 max-w-4xl w-full mx-auto space-y-6">
        {note && <div className="text-xs text-emerald-400">{note}</div>}

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Approval queue ({pending.length})</div>
          <div className="text-xs text-[#8e8e8e] mt-1">Member uploads wait here. Approving admits them to the shared library for everyone.</div>
          <div className="mt-3 space-y-2">
            {pending.map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{d.title || "(untitled)"}</div>
                  <div className="text-xs text-[#5f5f5f] truncate">{d.original_filename} • {new Date(d.created_at).toLocaleString()}</div>
                </div>
                <button onClick={() => decide(d.id, "approved")} className="rounded-lg bg-white text-black px-3 py-1.5 text-xs font-medium">Approve</button>
                <button onClick={() => decide(d.id, "rejected")} className="rounded-lg border border-red-900/50 text-red-400 px-3 py-1.5 text-xs">Reject</button>
              </div>
            ))}
            {pending.length === 0 && <div className="text-sm text-[#5f5f5f]">Queue is empty.</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Shared-chat deletion requests ({delRequests.length})</div>
          <div className="text-xs text-[#8e8e8e] mt-1">Owners cannot delete published research unilaterally — approving removes the chat and its messages.</div>
          <div className="mt-3 space-y-2">
            {delRequests.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{r.chat_title || "(deleted)"}</div>
                  <div className="text-xs text-[#5f5f5f] truncate">requested {new Date(r.created_at).toLocaleString()}</div>
                </div>
                <button onClick={() => decideDeletion(r.id, "approved")} className="rounded-lg bg-white text-black px-3 py-1.5 text-xs font-medium">Approve delete</button>
                <button onClick={() => decideDeletion(r.id, "rejected")} className="rounded-lg border border-[#2f2f2f] text-[#ececec] px-3 py-1.5 text-xs">Reject</button>
              </div>
            ))}
            {delRequests.length === 0 && <div className="text-sm text-[#5f5f5f]">No deletion requests.</div>}
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Member limit (soft, ≤ {MAX_ALLOWED_MEMBERS})</div>
          <div className="text-xs text-[#8e8e8e] mt-1">New registrations close when the workspace reaches this limit. The absolute ceiling of {MAX_ALLOWED_MEMBERS} is enforced server-side.</div>
          <div className="mt-3 flex gap-2 items-center">
            <input
              type="number"
              min={1}
              max={MAX_ALLOWED_MEMBERS}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-24 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
            />
            <button onClick={saveLimit} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium">Save</button>
          </div>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold text-white">Members ({members.length})</div>
            <button onClick={load} className="ml-auto rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1 text-xs text-white hover:bg-[#2f2f2f]">↻ Refresh</button>
          </div>
          <div className="mt-3 space-y-2">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm">
                <span className="font-mono text-xs text-[#5f5f5f]">{m.user_id.slice(0, 8)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs border ${m.role === "admin" ? "bg-white text-black border-white" : "bg-[#212121] border-[#2f2f2f] text-[#ececec]"}`}>{m.role}</span>
                <span className="text-xs text-[#5f5f5f]">joined {new Date(m.joined_at).toLocaleDateString()}</span>
                {m.user_id !== user?.id && (
                  <button onClick={() => kick(m.user_id)} className="ml-auto text-xs text-red-400 hover:text-red-300 border border-red-900/50 rounded-lg px-3 py-1.5">
                    Kick
                  </button>
                )}
              </div>
            ))}
            {members.length === 0 && <div className="text-sm text-[#5f5f5f]">No members.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
