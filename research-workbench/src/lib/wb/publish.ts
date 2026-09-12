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

async function requireWorkspace(sb: ReturnType<typeof createClient>, userId: string): Promise<string> {
  const { data: m } = await sb
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("joined_at")
    .limit(1)
    .maybeSingle();
  if (!m) throw new Error("No workspace");
  return (m as { workspace_id: string }).workspace_id;
}

function buildMessageRows(chatId: string, conv: Conversation) {
  return conv.messages
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
}

async function insertChat(
  sb: ReturnType<typeof createClient>,
  wsId: string,
  ownerId: string,
  title: string,
  visibility: "workspace" | "private",
): Promise<string> {
  const { data: chat, error: chatErr } = await sb
    .from("chats")
    .insert({ workspace_id: wsId, owner_id: ownerId, title, visibility })
    .select("id")
    .single();
  if (chatErr || !chat) throw new Error(chatErr?.message ?? "Publish failed");
  return (chat as { id: string }).id;
}

export async function publishConversation(conv: Conversation): Promise<string> {
  if (!conv.messages.length) throw new Error("Nothing to publish in this chat");
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const wsId = await requireWorkspace(sb, me.user.id);
  const chatId = await insertChat(sb, wsId, me.user.id, conv.title || "Shared research", "workspace");

  // Persist sources/thinking/model alongside content so the gallery renders
  // the full result and imports restore it.
  const rows = buildMessageRows(chatId, conv);
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

// Stored chats (hybrid opt-in sync) ------------------------------------------
// A Stored chat is a private account-level backup of a local conversation:
// same rows as a publish, but visibility 'private' so only the owner reads
// it (existing chats_read_ws covers owner reads). Other devices download it
// into their own local history. Last writer wins on re-sync (full replace).

export async function uploadConversation(conv: Conversation): Promise<string> {
  if (!conv.messages.length) throw new Error("Nothing to store in this chat");
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const wsId = await requireWorkspace(sb, me.user.id);
  const chatId = await insertChat(sb, wsId, me.user.id, conv.title || "Stored chat", "private");
  const rows = buildMessageRows(chatId, conv);
  if (rows.length) {
    const { error: msgErr } = await sb.from("chat_messages").insert(rows);
    if (msgErr) {
      await sb.from("chats").delete().eq("id", chatId);
      throw new Error(msgErr.message);
    }
  }
  return chatId;
}

/** Full-replace re-sync of a Stored chat: title + messages rewritten from
 *  the current local conversation. Ownership is verified first. */
export async function pushConversationUpdate(chatId: string, conv: Conversation): Promise<void> {
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const { data: chat } = await sb.from("chats").select("owner_id").eq("id", chatId).single();
  if (!chat) throw new Error("Stored chat not found");
  if ((chat as { owner_id: string }).owner_id !== me.user.id) throw new Error("Not your stored chat");
  const { error: titleErr } = await sb.from("chats").update({ title: conv.title || "Stored chat" }).eq("id", chatId);
  if (titleErr) throw new Error(titleErr.message);
  const { error: delErr } = await sb.from("chat_messages").delete().eq("chat_id", chatId);
  if (delErr) throw new Error(delErr.message);
  const rows = buildMessageRows(chatId, conv);
  if (rows.length) {
    const { error: msgErr } = await sb.from("chat_messages").insert(rows);
    if (msgErr) throw new Error(msgErr.message);
  }
}

export async function listStoredChats(): Promise<SharedChat[]> {
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
    .eq("owner_id", me.user.id)
    .eq("visibility", "private")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as SharedChat[];
}

export async function deleteStoredChat(chatId: string): Promise<void> {
  const sb = createClient();
  const { error } = await sb.from("chats").delete().eq("id", chatId);
  if (error) throw new Error(error.message);
}

/** Publish a finished makalah draft into the shared gallery as one readable
 *  assistant message (Markdown body + references). Gated by the caller with
 *  the same export blockers as Copy/Export so a holey paper never ships. */
export async function publishMakalah(input: {
  title: string;
  markdown: string;
  topic: string;
  language: string;
}): Promise<string> {
  if (!input.markdown.trim()) throw new Error("Nothing to publish");
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const wsId = await requireWorkspace(sb, me.user.id);
  const chatId = await insertChat(sb, wsId, me.user.id, input.title || "Makalah", "workspace");
  const { error: msgErr } = await sb.from("chat_messages").insert({
    chat_id: chatId,
    role: "assistant",
    content: input.markdown,
    metadata_json: { kind: "makalah", topic: input.topic, language: input.language },
  });
  if (msgErr) {
    await sb.from("chats").delete().eq("id", chatId);
    throw new Error(msgErr.message);
  }
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
