import { createClient } from "@/lib/supabase/client";

// Subscribe to workspace realtime events. Tables must be in the Realtime
// publication (see supabase/config.toml).
// Events: member joined · member kicked · document uploaded · document approved ·
//         chat created · chat imported · project changed.
export type RealtimeEvent =
  | "member-joined"
  | "member-kicked"
  | "document-uploaded"
  | "document-approved"
  | "chat-created"
  | "chat-imported"
  | "project-changed";

export function subscribeWorkspace(
  workspaceId: string,
  onEvent: (event: RealtimeEvent, payload: unknown) => void,
) {
  const supabase = createClient();
  const channel = supabase
    .channel(`workspace:${workspaceId}`)
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
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_imports" }, (payload) =>
      onEvent("chat-imported", payload.new),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "research_projects", filter: `workspace_id=eq.${workspaceId}` },
      (payload) => onEvent("project-changed", payload.new ?? payload.old),
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
