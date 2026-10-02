"use client";
import React, { createContext, useContext, useCallback } from "react";
import { useLocalStorageList, type StorageLike } from "./localStorage";

/**
 * Canonical stored chat message (owner: this module). The provider wire
 * shape ({role, content}) lives in lib/ai/types.ts as ChatMessage; convert
 * at the boundary with toProviderMessages() — never pass stored messages
 * with UI fields (id, timestamp, …) where the wire shape is expected.
 */
export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: any[];
  thinking?: string | null;
  broad?: boolean;
  thinkingEnabled?: boolean;
  hybridMode?: string;
  scopeIds?: string[];
  stopped?: boolean;
  timestamp: number;
  model?: string;
  type?: "ask" | "compare" | "summarize";
  meta?: any;
  /** Round-trip shape for shared-chat publish/import (kept optional). */
  metadata_json?: { provider?: string; model?: string; sources?: any[]; thinking?: string | null };
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredChatMessage[];
  /** Linked Stored-chat row id when this conversation is synced to the
   *  account (visibility 'private'). Absent = Local-only on this device. */
  cloudId?: string | null;
};

type ChatState = {
  conversations: Conversation[];
  activeId: string | null;
  activeConversation: Conversation | null;
  /** Non-null when conversation autosave stopped persisting (quota/full). */
  persistError: string | null;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  addMessage: (msg: StoredChatMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (id: string, patch: Partial<StoredChatMessage>) => void;
  truncateAfter: (id: string) => void;
  clearActive: () => void;
  /** "Clear memory": history before now is kept on screen but excluded from future prompts. */
  clearMemory: () => void;
  memoryCutoff: (id: string) => number;
  /** Import an external thread (e.g. a shared chat) as a new local conversation. */
  importConversation: (title: string, messages: StoredChatMessage[], cloudId?: string | null) => string;
  /** Link/unlink a local conversation to its Stored-chat row (sync state). */
  markStored: (id: string, chatId: string | null) => void;
};

const KEY_CONV = "wb_conversations_v1";
const KEY_ACTIVE = "wb_active_conversation_v1";
const KEY_CUTOFF = "wb_memory_cutoff_v1";
// legacy keys from the previous single-history version
const OLD_RESEARCH = "wb_research_chat_v2";
const OLD_COMPARE = "wb_compare_chat_v2";

const ChatContext = createContext<ChatState | null>(null);

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function freshConversation(): Conversation {
  const now = Date.now();
  return { id: uid(), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

function readCutoffs(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY_CUTOFF) ?? "{}");
  } catch {
    return {};
  }
}

// Legacy single-history migration (domain rule, kept verbatim): merge the
// flat histories into one conversation, then drop the old keys.
function migrateLegacyConversations(store: StorageLike | null): Conversation[] {
  const merged: StoredChatMessage[] = [];
  for (const key of [OLD_RESEARCH, OLD_COMPARE]) {
    try {
      const raw = store?.getItem(key) ?? null;
      if (raw) merged.push(...JSON.parse(raw));
    } catch {}
  }
  let convs: Conversation[] = [];
  if (merged.length) {
    merged.sort((a, b) => a.timestamp - b.timestamp);
    const firstUser = merged.find(m => m.role === "user");
    convs = [{
      id: uid(),
      title: (firstUser?.content || "Previous chat").slice(0, 40),
      createdAt: merged[0].timestamp,
      updatedAt: merged[merged.length - 1].timestamp,
      messages: merged,
    }];
  }
  try {
    store?.removeItem(OLD_RESEARCH);
    store?.removeItem(OLD_COMPARE);
  } catch {}
  return convs;
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  // Hydrate/persist via the shared hook (Phase 6): identical timing and
  // messages to the inline effects this replaces. Non-null persistError
  // means autosave stopped (quota or private mode): chats live only in
  // memory from here.
  const {
    items: conversations,
    activeId,
    setItems: setConversations,
    setActiveId,
    persistError,
  } = useLocalStorageList<Conversation>({
    itemsKey: KEY_CONV,
    activeKey: KEY_ACTIVE,
    parseItems: (raw) => (Array.isArray(raw) ? (raw as Conversation[]) : []),
    migrate: migrateLegacyConversations,
    getId: (c) => c.id,
    freshItem: freshConversation,
    onParseError: "empty",
    messages: {
      quotaMessage: "Browser storage is full — chats are kept only in this tab's memory. Export or delete old chats to save space.",
      failureMessage: "Chat autosave failed — chats are kept only in this tab's memory.",
    },
  });

  const newConversation = useCallback((): string => {
    let newId = "";
    setConversations(prev => {
      // reuse an already-empty active conversation instead of piling up empty chats
      if (activeId) {
        const active = prev.find(c => c.id === activeId);
        if (active && active.messages.length === 0) {
          newId = active.id;
          return prev;
        }
      }
      const c = freshConversation();
      newId = c.id;
      return [c, ...prev];
    });
    if (newId) setActiveId(newId);
    return newId;
  }, [activeId]);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const remaining = filtered.length ? filtered : [freshConversation()];
      if (activeId === id) setActiveId(remaining[0].id);
      return remaining;
    });
  }, [activeId]);

  const addMessage = useCallback((msg: StoredChatMessage) => {
    setConversations(prev => prev.map(c => {
      if (c.id !== activeId) return c;
      const isFirstUser = c.messages.length === 0 && msg.role === "user";
      const title = isFirstUser ? (msg.content.slice(0, 40) || "New chat") : c.title;
      return { ...c, title, updatedAt: Date.now(), messages: [...c.messages, msg] };
    }));
  }, [activeId]);

  const removeMessage = useCallback((id: string) => {
    setConversations(prev => prev.map(c =>
      c.id === activeId
        ? { ...c, updatedAt: Date.now(), messages: c.messages.filter(m => m.id !== id) }
        : c
    ));
  }, [activeId]);

  const updateMessage = useCallback((id: string, patch: Partial<StoredChatMessage>) => {
    setConversations(prev => prev.map(c =>
      c.id === activeId
        ? {
            ...c,
            updatedAt: Date.now(),
            messages: c.messages.map(m => (m.id === id ? { ...m, ...patch } : m)),
          }
        : c
    ));
  }, [activeId]);

  const truncateAfter = useCallback((id: string) => {
    setConversations(prev => prev.map(c => {
      if (c.id !== activeId) return c;
      const idx = c.messages.findIndex(m => m.id === id);
      if (idx < 0) return c;
      return { ...c, updatedAt: Date.now(), messages: c.messages.slice(0, idx + 1) };
    }));
  }, [activeId]);

  const clearActive = useCallback(() => {
    setConversations(prev => prev.map(c =>
      c.id === activeId
        ? { ...c, title: "New chat", messages: [], updatedAt: Date.now() }
        : c
    ));
  }, [activeId]);

  const memoryCutoff = useCallback((id: string): number => {
    if (typeof window === "undefined") return 0;
    return readCutoffs()[id] ?? 0;
  }, []);

  const importConversation = useCallback((title: string, messages: StoredChatMessage[], cloudId?: string | null): string => {
    const now = Date.now();
    const c: Conversation = {
      id: uid(),
      title: title.slice(0, 60) || "Imported chat",
      createdAt: now,
      updatedAt: now,
      messages,
      ...(cloudId ? { cloudId } : {}),
    };
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    return c.id;
  }, []);

  const markStored = useCallback((id: string, chatId: string | null) => {
    setConversations((prev) => prev.map((c) =>
      c.id === id ? { ...c, cloudId: chatId, updatedAt: Date.now() } : c,
    ));
  }, []);

  const clearMemory = useCallback(() => {
    if (!activeId) return;
    try {
      const all = readCutoffs();
      all[activeId] = Date.now();
      localStorage.setItem(KEY_CUTOFF, JSON.stringify(all));
    } catch {}
  }, [activeId]);

  const activeConversation = conversations.find(c => c.id === activeId) || null;

  return (
    <ChatContext.Provider value={{
      conversations, activeId, activeConversation, persistError,
      removeMessage, updateMessage, truncateAfter,
      newConversation, selectConversation, deleteConversation, addMessage, clearActive,
      clearMemory, memoryCutoff, importConversation, markStored,
    }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
