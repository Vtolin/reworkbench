// Shared-chat publishing: Research conversations are per-device history;
// publishing exports one to the workspace gallery (chats + chat_messages)
// for others to read and import into their own Research. Nothing starts in
// the gallery — it only receives published research.
import { createClient } from "@/lib/supabase/client";
import type { Conversation, ChatMessage } from "@/contexts/ChatContext";

const LS_PUBLISHED = "rw.published_conversations.v1"; // {localConvId: sharedChatId}

export function publishedMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_PUBLISHED) ?? "{}");
  } catch {
    return {};
  }
}

function markPublished(localId: string, chatId: string): void {
  try {
    localStorage.setItem(LS_PUBLISHED, JSON.stringify({ ...publishedMap(), [localId]: chatId }));
  } catch {
    /* ignore */
  }
}

export async function publishConversation(conv: Conversation): Promise<string> {
  if (!conv.messages.length) throw new Error("Nothing to publish in this chat");
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const { data: m } = await sb
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", me.user.id)
    .eq("status", "active")
    .order("joined_at")
    .limit(1)
    .maybeSingle();
  if (!m) throw new Error("No workspace");
  const wsId = (m as { workspace_id: string }).workspace_id;

  const { data: chat, error: chatErr } = await sb
    .from("chats")
    .insert({
      workspace_id: wsId,
      owner_id: me.user.id,
      title: conv.title || "Shared research",
      visibility: "workspace",
    })
    .select("id")
    .single();
  if (chatErr || !chat) throw new Error(chatErr?.message ?? "Publish failed");
  const chatId = (chat as { id: string }).id;

  // Persist sources/thinking/model alongside content so the gallery renders
  // the full result and imports restore it.
  const rows = conv.messages
    .filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content.trim())
    .map((msg) => ({
      chat_id: chatId,
      role: msg.role,
      content: msg.content,
      metadata_json: {
        ...(msg.role === "assistant"
          ? { provider: "ollama", model: msg.model ?? null, sources: msg.sources ?? [], thinking: msg.thinking ?? null }
          : {}),
      },
    }));
  if (rows.length) {
    const { error: msgErr } = await sb.from("chat_messages").insert(rows);
    if (msgErr) {
      await sb.from("chats").delete().eq("id", chatId);
      throw new Error(msgErr.message);
    }
  }
  markPublished(conv.id, chatId);
  return chatId;
}

export interface SharedChat {
  id: string;
  title: string;
  owner_id: string;
  created_at: string;
  message_count?: number;
}

export async function listSharedChats(): Promise<SharedChat[]> {
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) return [];
  const { data: m } = await sb
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", me.user.id)
    .eq("status", "active")
    .order("joined_at")
    .limit(1)
    .maybeSingle();
  if (!m) return [];
  const { data, error } = await sb
    .from("chats")
    .select("id, title, owner_id, created_at")
    .eq("workspace_id", (m as { workspace_id: string }).workspace_id)
    .eq("visibility", "workspace")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as SharedChat[];
}

export async function fetchSharedChat(chatId: string): Promise<{ chat: SharedChat; messages: ChatMessage[] }> {
  const sb = createClient();
  const { data: chat } = await sb.from("chats").select("id, title, owner_id, created_at").eq("id", chatId).single();
  if (!chat) throw new Error("Shared chat not found");
  const { data: msgs, error } = await sb
    .from("chat_messages")
    .select("role, content, metadata_json, created_at")
    .eq("chat_id", chatId)
    .order("created_at");
  if (error) throw new Error(error.message);
  const now = Date.now();
  const messages: ChatMessage[] = ((msgs ?? []) as Array<{
    role: string; content: string; metadata_json: { sources?: unknown; thinking?: string; model?: string; provider?: string } | null;
  }>).map((r, i) => ({
    id: `imp_${now}_${i}`,
    role: r.role as "user" | "assistant",
    content: r.content,
    sources: Array.isArray(r.metadata_json?.sources) ? (r.metadata_json.sources as ChatMessage["sources"]) : undefined,
    thinking: r.metadata_json?.thinking ?? null,
    model: r.metadata_json?.model ?? undefined,
    timestamp: now + i,
    type: "ask" as const,
    metadata_json: r.metadata_json as ChatMessage["metadata_json"],
  }));
  return { chat: chat as SharedChat, messages };
}

// Deletion requests (owner files, admin decides) ---------------------------------
export async function requestChatDeletion(chatId: string): Promise<void> {
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const { data: chat } = await sb.from("chats").select("workspace_id").eq("id", chatId).single();
  if (!chat) throw new Error("Chat not found");
  const { error } = await sb.from("chat_deletion_requests").insert({
    workspace_id: (chat as { workspace_id: string }).workspace_id,
    chat_id: chatId,
    requested_by: me.user.id,
    status: "pending",
  });
  if (error) throw new Error(error.message);
}

export async function myPendingDeletion(chatId: string): Promise<boolean> {
  const sb = createClient();
  const { data } = await sb
    .from("chat_deletion_requests")
    .select("id")
    .eq("chat_id", chatId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  return !!data;
}

export interface DeletionRequest {
  id: string;
  chat_id: string | null;
  chat_title?: string;
  requested_by: string;
  created_at: string;
}

export async function listDeletionRequests(): Promise<DeletionRequest[]> {
  const sb = createClient();
  const { data, error } = await sb
    .from("chat_deletion_requests")
    .select("id, chat_id, requested_by, created_at, chats(title)")
    .eq("status", "pending")
    .order("created_at");
  if (error) throw new Error(error.message);
  return (((data ?? []) as unknown) as Array<{
    id: string; chat_id: string | null; requested_by: string; created_at: string;
    chats: { title: string } | null;
  }>).map((r) => ({ ...r, chat_title: r.chats?.title }));
}

export async function decideDeletionRequest(id: string, decision: "approved" | "rejected"): Promise<void> {
  const sb = createClient();
  const { data: req } = await sb.from("chat_deletion_requests").select("chat_id, workspace_id").eq("id", id).single();
  if (!req) throw new Error("Request not found");
  const chatId = (req as { chat_id: string | null }).chat_id;
  if (decision === "approved" && chatId) {
    // Admin RLS permits this delete; messages cascade.
    const { error: delErr } = await sb.from("chats").delete().eq("id", chatId);
    if (delErr) throw new Error(delErr.message);
  }
  const { error } = await sb
    .from("chat_deletion_requests")
    .update({ status: decision, decided_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
