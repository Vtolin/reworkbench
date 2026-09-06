"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useInference } from "@/contexts/InferenceContext";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";

interface Chat {
  id: string;
  title: string;
  owner_id: string;
  visibility: string;
}
interface Msg {
  id: string;
  role: string;
  content: string;
  metadata_json: { provider?: string; model?: string };
}

// Chat persistence lives in Postgres (chats/chat_messages/chat_imports + RLS).
// Everyone reads workspace-visible chats; only the owner continues their own.
// Others use "Import to my chats" (copies into a new independent thread).
export default function ChatsPage() {
  const { workspace, user } = useSession();
  const { settings } = useInference();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const loadChats = async () => {
    if (!workspace) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("chats")
      .select("id, title, owner_id, visibility")
      .eq("workspace_id", workspace.id)
      .order("updated_at", { ascending: false })
      .limit(50);
    setChats((data ?? []) as Chat[]);
  };

  const loadMessages = async (chatId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from("chat_messages")
      .select("id, role, content, metadata_json")
      .eq("chat_id", chatId)
      .order("created_at");
    setMessages((data ?? []) as Msg[]);
  };

  useEffect(() => {
    loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const createChat = async () => {
    if (!workspace || !user) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("chats")
      .insert({ workspace_id: workspace.id, owner_id: user.id, title: "New chat" })
      .select("id, title, owner_id, visibility")
      .single();
    if (data) {
      setChats((prev) => [data as Chat, ...prev]);
      setActiveId((data as Chat).id);
      setMessages([]);
    }
  };

  const openChat = async (id: string) => {
    setActiveId(id);
    await loadMessages(id);
  };

  const send = async () => {
    if (!activeId || !user || !draft.trim()) return;
    const active = chats.find((c) => c.id === activeId);
    if (!active || active.owner_id !== user.id) return; // RLS would reject anyway
    setBusy(true);
    const supabase = createClient();
    await supabase.from("chat_messages").insert({ chat_id: activeId, role: "user", content: draft });
    const history = [...messages, { id: "tmp", role: "user", content: draft, metadata_json: {} } as Msg];
    setMessages(history);
    setDraft("");
    try {
      const provider =
        settings.provider === "ollama" ? new OllamaProvider() : new CloudProvider(settings.cloudProvider);
      const model = settings.provider === "ollama" ? settings.model : settings.cloudModel;
      const result = await provider.chat(
        history.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
        { model, temperature: settings.temperature, numCtx: settings.numCtx },
      );
      // Only {provider, model} recorded for reproducibility — never keys/settings.
      await supabase.from("chat_messages").insert({
        chat_id: activeId,
        role: "assistant",
        content: result.content,
        metadata_json: { provider: result.provider, model: result.model },
      });
      await loadMessages(activeId);
    } finally {
      setBusy(false);
    }
  };

  const importChat = async (sourceChatId: string) => {
    const res = await fetch("/api/chats/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceChatId }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadChats();
      await openChat(data.targetChatId as string);
    }
  };

  const active = chats.find((c) => c.id === activeId);
  const mine = active && user ? active.owner_id === user.id : false;

  return (
    <main className="mx-auto flex max-w-6xl gap-6 px-6 py-12">
      <aside className="w-64 shrink-0">
        <button onClick={createChat} className="w-full rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-black">
          New chat
        </button>
        <ul className="mt-4 space-y-1">
          {chats.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => openChat(c.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm ${c.id === activeId ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
              >
                {c.title}
                {user && c.owner_id !== user.id && <span className="ml-2 text-xs text-neutral-500">(shared)</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex-1">
        {!active ? (
          <p className="text-sm text-neutral-500">Select or create a chat.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold text-neutral-100">{active.title}</h1>
              {!mine && (
                <button
                  onClick={() => importChat(active.id)}
                  className="rounded border border-neutral-700 px-3 py-1 text-sm text-neutral-200"
                >
                  Import to my chats
                </button>
              )}
            </div>
            {!mine && (
              <p className="mt-1 text-sm text-neutral-500">
                Read-only: only the owner can continue this chat. Import it to branch your own thread.
              </p>
            )}
            <div className="mt-4 space-y-3">
              {messages.map((m) => (
                <div key={m.id} className="rounded border border-neutral-800 bg-neutral-950 p-3 text-sm">
                  <p className="text-xs text-neutral-500">
                    {m.role}
                    {m.metadata_json?.provider ? ` · ${m.metadata_json.provider}:${m.metadata_json.model}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-neutral-100">{m.content}</p>
                </div>
              ))}
            </div>
            {mine && (
              <div className="mt-4 flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Continue this chat (your own model)…"
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
                />
                <button
                  onClick={send}
                  disabled={busy}
                  className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
