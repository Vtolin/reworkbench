import { createClient } from "@/lib/supabase/client";

// Subscribe to workspace realtime events. Tables must be in the Realtime
// publication (see supabase/config.toml + migration 0009).
// Events: member joined · member kicked · document uploaded · document approved ·
//         chat created · chat imported · project changed ·
//         collection changed · tag changed.
// Consumers stay label-only: they refetch by event type and never read row
// data out of the payload.
export type RealtimeEvent =
  | "member-joined"
  | "member-kicked"
  | "document-uploaded"
  | "document-approved"
  | "chat-created"
  | "chat-imported"
  | "project-changed"
  | "collection-changed"
  | "tag-changed";

// Unique channel per subscriber (module counter): supabase-js hands back the
// SAME channel object for a repeated topic, and .on() after .subscribe()
// throws ("cannot add postgres_changes callbacks … after subscribe()").
// Sidebar, the library page and RealtimeToasts subscribe concurrently, so a
// static `workspace:<id>` topic collides on mount (same precedent as the
// admin page's per-mount channel names). Topics are connection-local, so a
// counter suffices — removeChannel still tears down exactly this channel.
let channelSeq = 0;

export function subscribeWorkspace(
  workspaceId: string,
  onEvent: (event: RealtimeEvent, payload: unknown) => void,
  opts?: { onStatus?: (status: string) => void },
) {
  const supabase = createClient();
  const channel = supabase
    .channel(`workspace:${workspaceId}:${++channelSeq}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "workspace_members", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => {
        if (payload.eventType === "INSERT") onEvent("member-joined", payload.new);
        else onEvent("member-kicked", payload.new ?? payload.old);
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "documents", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => {
        const row = (payload.new ?? payload.old) as { status?: string };
        if (payload.eventType === "INSERT") onEvent("document-uploaded", payload.new);
        else if (row?.status === "approved") onEvent("document-approved", payload.new);
        else onEvent("document-uploaded", payload.new ?? payload.old);
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chats", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => onEvent("chat-created", payload.new),
    )
    // chat_imports carries no workspace_id, so the server cannot scope this
    // subscription (a filter on target_chat_id would need a join). Without a
    // relevance check, one workspace's import toasts every client subscribed
    // to any workspace — most visibly for users in several workspaces.
    // Imports are rare, so one indexed lookup per event is negligible; only
    // imports targeting THIS workspace surface. (Realtime RLS already hides
    // rows the caller cannot read; this handles the multi-workspace member
    // whose rows are legitimately visible but belong elsewhere.)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_imports" }, (payload) => {
      const row = payload.new as { target_chat_id?: string } | null;
      if (!row?.target_chat_id) return;
      void supabase
        .from("chats")
        .select("workspace_id")
        .eq("id", row.target_chat_id)
        .maybeSingle()
        .then(({ data }) => {
          if (data && (data as { workspace_id: string }).workspace_id === workspaceId) {
            onEvent("chat-imported", payload.new);
          }
        });
    })
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "research_projects", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => onEvent("project-changed", payload.new ?? payload.old),
    )
    // Directory lists (Phase 2): collections/tags carry workspace_id, so
    // these stay server-filtered at the source like every table above.
    // Published via migration 0009; without it no events flow and consumers
    // fall back to their 60s poll.
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "collections", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => onEvent("collection-changed", payload.new ?? payload.old),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tags", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => onEvent("tag-changed", payload.new ?? payload.old),
    )
    .subscribe((status) => opts?.onStatus?.(status));
  return () => {
    supabase.removeChannel(channel);
  };
}
