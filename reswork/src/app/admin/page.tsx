"use client";
import { toUserMessage } from "@/lib/errors";

import { useEffect, useId, useState } from "react";
import Topbar from "@/components/Topbar";
import { useSession } from "@/contexts/SessionContext";
import { MAX_ALLOWED_MEMBERS } from "@/lib/permissions/constants";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

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

interface HealthRow {
  document_id: string;
  title: string;
  ingestion_status: string;
  ingestion_error: string | null;
  chunks: number;
  embedded: number;
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
  // Ingest health (Phase 4): error + FTS-only/partial documents via one RPC,
  // plus storage orphans. Loaded on demand with the rest of the dashboard.
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Library reindex scope + progress (missing-only fills gaps, the cheapest;
  // full clears and rebuilds every vector for a model change or drift).
  const [reindexScope, setReindexScope] = useState<"missing" | "full">("missing");
  const [reindexProgress, setReindexProgress] = useState<[number, number] | null>(null);

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
    try {
      const { fetchIngestHealth } = await import("@/lib/wb/ingest");
      setHealth(await fetchIngestHealth());
      setHealthError(null);
    } catch (e) {
      // Migration 0013 not applied (or RPC blocked): panel shows the hint.
      setHealth([]);
      setHealthError(e instanceof Error ? e.message : "Ingest health unavailable");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Live refresh: a member joining (or being kicked) while this page is open
  // shows up immediately instead of waiting for a manual reload.
  // Unique channel per mount + removeChannel cleanup: re-subscribing to a
  // static name while the old channel still exists throws
  // "cannot add postgres_changes callbacks … after subscribe()".
  // useId is stable per mount and pure (no render-phase ref/impure calls).
  const mountId = useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    let client: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    (async () => {
      const { createClient } = await import("@/lib/supabase/client");
      if (cancelled) return;
      client = createClient();
      channel = client
        .channel(`admin-members:${workspace.id}:${mountId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "workspace_members", filter: `workspace_id=eq.${workspace.id}` },
          () => load(),
        );
      channel.subscribe();
    })();
    return () => {
      cancelled = true;
      if (client && channel) client.removeChannel(channel);
    };
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

  // Idempotent repair: embeds exactly the chunks missing vectors (skips the
  // rest), flips error→ready when fully covered. Uses this device's embed
  // mode, like uploads do.
  const reembed = async () => {
    setBusy("reembed");
    try {
      const { reembedMissingEmbeddings } = await import("@/lib/wb/ingest");
      const { readInference } = await import("@/lib/api");
      const s = await reembedMissingEmbeddings({ embedMode: readInference().embedMode });
      flash(`Re-embed: ${s.docsFixed}/${s.docsScanned} docs fixed, ${s.chunksEmbedded} vectors added, ${s.chunksSkipped} skipped${s.warnings.length ? ` — ${s.warnings.length} warning(s): ${s.warnings[0]?.slice(0, 200)}` : ""}`);
      load();
    } catch (e) {
      flash(toUserMessage(e, "Re-embed failed"));
    } finally {
      setBusy(null);
    }
  };

  const reindex = async () => {
    if (!confirm(reindexScope === "full"
      ? "Full reindex clears and rebuilds every document vector with this device's embedding mode. Large libraries take a while. Continue?"
      : "Re-embed chunks missing vectors?")) return;
    setBusy("reindex");
    setReindexProgress(null);
    try {
      const { api } = await import("@/lib/api");
      const s = await api.reindex(reindexScope, undefined, (done, total) => setReindexProgress([done, total]));
      flash(`Reindex (${reindexScope}): ${s.docsFixed}/${s.docsScanned} docs, ${s.chunksEmbedded} vectors${s.chunksDeleted ? `, ${s.chunksDeleted} cleared` : ""}, ${s.chunksSkipped} skipped${s.warnings.length ? ` — ${s.warnings.length} warning(s): ${s.warnings[0]?.slice(0, 200)}` : ""}`);
      load();
    } catch (e) {
      flash(toUserMessage(e, "Reindex failed"));
    } finally {
      setBusy(null);
      setReindexProgress(null);
    }
  };

  const scanOrphans = async () => {
    setBusy("orphans");
    try {
      const { listOrphanStoragePaths } = await import("@/lib/wb/ingest");
      const scan = await listOrphanStoragePaths();
      setOrphans(scan.orphans);
      flash(scan.orphans.length ? `${scan.orphans.length} orphaned object(s) found` : "No orphaned storage objects");
    } catch (e) {
      flash(toUserMessage(e, "Orphan scan failed"));
    } finally {
      setBusy(null);
    }
  };

  const sweepOrphans = async () => {
    if (!orphans?.length || !confirm(`Delete ${orphans.length} orphaned storage object(s)? Documents are untouched.`)) return;
    setBusy("sweep");
    try {
      const { sweepOrphanStorage } = await import("@/lib/wb/ingest");
      const r = await sweepOrphanStorage(orphans);
      setOrphans(r.removed.length === orphans.length ? [] : null);
      flash(`Sweep: ${r.removed.length} removed${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`);
      if (r.removed.length) scanOrphans();
    } catch (e) {
      flash(toUserMessage(e, "Sweep failed"));
    } finally {
      setBusy(null);
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
      flash(toUserMessage(e, "Decision failed"));
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
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold text-white">Ingest health ({health.length})</div>
            <button onClick={reembed} disabled={busy !== null || health.length === 0} className="ml-auto rounded-lg bg-white text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40">
              {busy === "reembed" ? "Re-embedding…" : "Re-embed missing"}
            </button>
          </div>
          <div className="text-xs text-[#8e8e8e] mt-1">Errored documents and FTS-only (no vectors) documents. Re-embed is idempotent — chunks that already have vectors are skipped.</div>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2">
            <span className="text-xs text-[#8e8e8e]">Library reindex:</span>
            <select
              value={reindexScope}
              onChange={(e) => setReindexScope(e.target.value as "missing" | "full")}
              disabled={busy !== null}
              className="rounded-lg border border-[#2f2f2f] bg-black px-2 py-1.5 text-xs text-white outline-none disabled:opacity-40"
              title="missing: fill gaps only (cheapest) • full: clear + rebuild every vector (model change)"
            >
              <option value="missing" className="bg-[#171717]">missing vectors only</option>
              <option value="full" className="bg-[#171717]">full — rebuild all vectors</option>
            </select>
            <button onClick={reindex} disabled={busy !== null} className="rounded-lg bg-white text-black px-3 py-1.5 text-xs font-medium disabled:opacity-40">
              {busy === "reindex" ? `Reindexing${reindexProgress ? ` ${reindexProgress[0]}/${reindexProgress[1]}` : "… "}` : "Run reindex"}
            </button>
            {reindexScope === "full" && <span className="text-[11px] text-amber-300/80">Clears vectors first — retry refills gaps if embedding fails mid-run.</span>}
          </div>
          {healthError && <div className="mt-2 text-xs text-red-400">Health check unavailable: {healthError} (apply migration 0013).</div>}
          <div className="mt-3 space-y-2">
            {health.map((d) => {
              const ftsOnly = d.chunks > 0 && d.embedded === 0;
              const badge = d.ingestion_status === "error"
                ? <span className="rounded-full px-2 py-0.5 text-xs border border-red-900/50 text-red-400">error</span>
                : ftsOnly
                  ? <span className="rounded-full px-2 py-0.5 text-xs border border-amber-900/50 text-amber-400">FTS-only</span>
                  : <span className="rounded-full px-2 py-0.5 text-xs border border-[#2f2f2f] text-[#ececec]">partial</span>;
              return (
                <div key={d.document_id} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-white truncate flex-1 min-w-0">{d.title || "(untitled)"}</div>
                    {badge}
                  </div>
                  <div className="text-xs text-[#5f5f5f] truncate">{d.embedded}/{d.chunks} vectors{d.ingestion_error ? ` • ${d.ingestion_error}` : ""}</div>
                </div>
              );
            })}
            {!healthError && health.length === 0 && <div className="text-sm text-[#5f5f5f]">All documents healthy.</div>}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <div className="text-xs text-[#8e8e8e]">Storage orphans (uploads with no documents row){orphans !== null && ` — ${orphans.length} found`}.</div>
            <button onClick={scanOrphans} disabled={busy !== null} className="ml-auto rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white hover:bg-[#2f2f2f] disabled:opacity-40">
              {busy === "orphans" ? "Scanning…" : "Scan orphans"}
            </button>
            {(orphans?.length ?? 0) > 0 && (
              <button onClick={sweepOrphans} disabled={busy !== null} className="rounded-lg border border-red-900/50 text-red-400 px-3 py-1.5 text-xs disabled:opacity-40">
                {busy === "sweep" ? "Sweeping…" : `Delete ${orphans!.length} orphan(s)`}
              </button>
            )}
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
