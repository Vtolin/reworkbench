"use client";
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

export type ChatMessage = {
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
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type ChatState = {
  conversations: Conversation[];
  activeId: string | null;
  activeConversation: Conversation | null;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  addMessage: (msg: ChatMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  truncateAfter: (id: string) => void;
  clearActive: () => void;
  /** "Clear memory": history before now is kept on screen but excluded from future prompts. */
  clearMemory: () => void;
  memoryCutoff: (id: string) => number;
  /** Import an external thread (e.g. a shared chat) as a new local conversation. */
  importConversation: (title: string, messages: ChatMessage[]) => string;
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

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // hydrate from localStorage once, migrating the legacy single-history keys
  useEffect(() => {
    try {
      let convs: Conversation[] = [];
      const raw = localStorage.getItem(KEY_CONV);
      if (raw) convs = JSON.parse(raw);
      let active = localStorage.getItem(KEY_ACTIVE);

      if (!convs.length) {
        // migrate legacy flat history into one conversation
        const merged: ChatMessage[] = [];
        try {
          const oldR = localStorage.getItem(OLD_RESEARCH);
          if (oldR) merged.push(...JSON.parse(oldR));
        } catch {}
        try {
          const oldC = localStorage.getItem(OLD_COMPARE);
          if (oldC) merged.push(...JSON.parse(oldC));
        } catch {}
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
        localStorage.removeItem(OLD_RESEARCH);
        localStorage.removeItem(OLD_COMPARE);
      }

      if (!convs.length) {
        convs = [freshConversation()];
      }
      if (!active || !convs.some(c => c.id === active)) {
        active = convs[0].id;
      }
      setConversations(convs);
      setActiveId(active);
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(KEY_CONV, JSON.stringify(conversations)); } catch {}
  }, [conversations, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(KEY_ACTIVE, activeId || ""); } catch {}
  }, [activeId, hydrated]);

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

  const addMessage = useCallback((msg: ChatMessage) => {
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

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
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

  const importConversation = useCallback((title: string, messages: ChatMessage[]): string => {
    const now = Date.now();
    const c: Conversation = {
      id: uid(),
      title: title.slice(0, 60) || "Imported chat",
      createdAt: now,
      updatedAt: now,
      messages,
    };
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    return c.id;
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
      conversations, activeId, activeConversation,
      removeMessage, updateMessage, truncateAfter,
      newConversation, selectConversation, deleteConversation, addMessage, clearActive,
      clearMemory, memoryCutoff, importConversation,
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
