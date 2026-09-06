"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useInference } from "@/contexts/InferenceContext";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import Topbar from "@/components/Topbar";

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
      await supabase.from("chats").update({ title: history[0]?.content.slice(0, 40) || "Chat" }).eq("id", activeId);
      await loadMessages(activeId);
      loadChats();
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
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Chats" subtitle="Workspace-visible threads • only the owner continues a chat — import it to branch your own" actions={
        <button onClick={createChat} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium hover:bg-[#ececec]">+ New chat</button>
      } />
      <div className="flex flex-1 min-h-0">
        <aside className="w-64 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] p-2 space-y-1 overflow-y-auto no-scrollbar hidden sm:block">
          {chats.length === 0 && <div className="text-xs text-[#5f5f5f] p-3 text-center">No chats yet</div>}
          {chats.map((c) => (
            <div
              key={c.id}
              onClick={() => openChat(c.id)}
              className={`group rounded-xl px-3 py-2.5 cursor-pointer border ${c.id === activeId ? "bg-[#212121] border-[#2f2f2f]" : "border-transparent hover:bg-[#171717]"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8e8e8e] shrink-0">◭</span>
                <span className="text-sm truncate flex-1 text-[#ececec]">{c.title}</span>
              </div>
              <div className="text-[11px] text-[#5f5f5f] mt-0.5">
                {user && c.owner_id === user.id ? "yours" : "shared"}
              </div>
            </div>
          ))}
        </aside>
        {/* mobile chat picker */}
        <div className="sm:hidden w-full border-b border-[#2f2f2f] bg-[#0a0a0a] p-2 flex gap-2 overflow-x-auto no-scrollbar">
          {chats.map((c) => (
            <button key={c.id} onClick={() => openChat(c.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs border ${c.id === activeId ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>
              {c.title}
            </button>
          ))}
        </div>
        <section className="flex-1 min-w-0 hidden sm:flex flex-col">
          {!active ? (
            <div className="flex-1 grid place-items-center">
              <div className="text-center">
                <div className="h-12 w-12 mx-auto rounded-2xl bg-white text-black grid place-items-center text-xl mb-4">◭</div>
                <div className="font-medium text-white">Select or create a chat</div>
                <div className="text-sm text-[#8e8e8e] mt-1">Read any workspace thread. Continue only your own — or import to branch.</div>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 lg:px-6 py-3 border-b border-[#2f2f2f] flex items-center gap-3">
                <h1 className="text-base font-semibold text-white truncate flex-1">{active.title}</h1>
                {!mine && (
                  <button
                    onClick={() => importChat(active.id)}
                    className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white hover:bg-[#2f2f2f] shrink-0"
                  >
                    Import to my chats
                  </button>
                )}
              </div>
              {!mine && (
                <p className="px-4 lg:px-6 py-2 text-xs text-[#5f5f5f] border-b border-[#2f2f2f]">Read-only: only the owner can continue this chat. Import it to branch your own thread.</p>
              )}
              <div className="flex-1 overflow-y-auto px-4 lg:px-6 py-4">
                <div className="max-w-3xl mx-auto space-y-4">
                  {messages.map((m) => (
                    <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      {m.role === "assistant" && <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center text-xs font-bold shrink-0 mt-1">✦</div>}
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words ${m.role === "user" ? "bg-[#212121] border border-[#2f2f2f] text-white" : "bg-transparent text-[#ececec]"}`}>
                        <p className="whitespace-pre-wrap">{m.content}</p>
                        {m.metadata_json?.provider && (
                          <p className="mt-1 text-[11px] text-[#5f5f5f]">{m.metadata_json.provider}:{m.metadata_json.model}</p>
                        )}
                      </div>
                      {m.role === "user" && <div className="h-7 w-7 rounded-full bg-[#2f2f2f] text-white grid place-items-center text-xs shrink-0 mt-1">You</div>}
                    </div>
                  ))}
                </div>
              </div>
              {mine && (
                <div className="shrink-0 border-t border-[#2f2f2f] bg-black px-4 py-4">
                  <div className="max-w-3xl mx-auto rounded-2xl bg-[#212121] border border-[#2f2f2f] flex items-end gap-2 p-2 focus-within:border-[#404040]">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                      rows={1}
                      placeholder="Continue this chat with your own model… (Shift+Enter newline)"
                      className="flex-1 bg-transparent text-white placeholder:text-[#8e8e8e] text-sm px-3 py-2.5 outline-none resize-none max-h-32"
                    />
                    <button onClick={send} disabled={busy || !draft.trim()} className="h-10 w-10 grid place-items-center rounded-xl bg-white text-black disabled:opacity-40 shrink-0">
                      <span className="text-lg">↑</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
