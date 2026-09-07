"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useChat } from "@/contexts/ChatContext";
import Topbar from "@/components/Topbar";
import Markdown from "@/components/Markdown";
import { fetchSharedChat, requestChatDeletion, myPendingDeletion } from "@/lib/wb/publish";

interface Chat {
  id: string;
  title: string;
  owner_id: string;
  created_at: string;
}
interface Msg {
  role: string;
  content: string;
  metadata_json: { provider?: string; model?: string; sources?: Array<{ citation: string; snippet: string }>; thinking?: string | null };
}

// Shared chats: a read-only gallery of published research. Nobody starts or
// continues a conversation here — publish from Research, import into Research.
// Deletion requires admin approval (owner files a request, admin decides).
export default function ChatsPage() {
  const { workspace, user } = useSession();
  const { importConversation } = useChat();
  const router = useRouter();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [deletionPending, setDeletionPending] = useState(false);

  const loadChats = async () => {
    if (!workspace) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("chats")
      .select("id, title, owner_id, created_at")
      .eq("workspace_id", workspace.id)
      .eq("visibility", "workspace")
      .order("updated_at", { ascending: false })
      .limit(50);
    setChats((data ?? []) as Chat[]);
  };

  useEffect(() => {
    loadChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(null), 3000); };

  const openChat = async (id: string) => {
    setActiveId(id);
    setDeletionPending(await myPendingDeletion(id).catch(() => false));
    try {
      const { messages: msgs } = await fetchSharedChat(id);
      setMessages(msgs as unknown as Msg[]);
    } catch {
      setMessages([]);
    }
  };

  const openInResearch = async () => {
    if (!activeId) return;
    try {
      const { chat, messages: msgs } = await fetchSharedChat(activeId);
      importConversation(`Imported: ${chat.title}`, msgs);
      router.push("/research");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Import failed");
    }
  };

  const askDeletion = async () => {
    if (!activeId || !confirm("Request deletion of this shared chat? An admin must approve.")) return;
    try {
      await requestChatDeletion(activeId);
      setDeletionPending(true);
      flash("Deletion requested — awaiting admin approval");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Request failed");
    }
  };

  const active = chats.find((c) => c.id === activeId);
  const mine = active && user ? active.owner_id === user.id : false;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar
        title="Shared chats"
        subtitle="Published research results — read here, continue in Research, delete only with admin approval"
      />
      {note && <div className="px-4 lg:px-6 pt-3 text-xs text-emerald-400">{note}</div>}
      <div className="flex flex-col sm:flex-row flex-1 min-w-0 pt-3 sm:min-h-0">
        <aside className="w-64 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] p-2 space-y-1 overflow-y-auto no-scrollbar hidden sm:block">
          {chats.length === 0 && <div className="text-xs text-[#5f5f5f] p-3 text-center">Nothing published yet — publish from Research → history → Publish ↑</div>}
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
                {user && c.owner_id === user.id ? "published by you" : "shared"} • {new Date(c.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </aside>
        <div className="sm:hidden w-full border-b border-[#2f2f2f] bg-[#0a0a0a] p-2 flex gap-2 overflow-x-auto no-scrollbar">
          {chats.map((c) => (
            <button key={c.id} onClick={() => openChat(c.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs border ${c.id === activeId ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>
              {c.title}
            </button>
          ))}
        </div>
        <section className="flex-1 min-w-0 flex flex-col sm:min-h-0">
          {!active ? (
            <div className="flex-1 grid place-items-center min-h-[40vh] sm:min-h-0 px-4">
              <div className="text-center max-w-sm">
                <div className="h-12 w-12 mx-auto rounded-2xl bg-white text-black grid place-items-center text-xl mb-4">◭</div>
                <div className="font-medium text-white">Published research, read-only</div>
                <div className="text-sm text-[#8e8e8e] mt-1">Open a thread to read it. To build on it, import it into your Research — your own model continues it there.</div>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 lg:px-6 py-3 border-b border-[#2f2f2f] flex items-center gap-2">
                <h1 className="text-base font-semibold text-white truncate flex-1">{active.title}</h1>
                <button
                  onClick={openInResearch}
                  className="rounded-xl bg-white text-black px-3 py-1.5 text-xs font-medium shrink-0 hover:bg-[#ececec]"
                >
                  Open in Research →
                </button>
                {mine && (
                  deletionPending ? (
                    <span className="text-[11px] text-amber-300 border border-amber-800 bg-amber-950/30 rounded-full px-3 py-1.5 shrink-0">Deletion requested ⌛</span>
                  ) : (
                    <button
                      onClick={askDeletion}
                      className="rounded-xl border border-red-900/50 bg-[#171717] px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/30 shrink-0"
                    >
                      Request deletion
                    </button>
                  )
                )}
              </div>
              <div className="flex-1 overflow-y-auto px-4 lg:px-6 py-4">
                <div className="max-w-3xl mx-auto space-y-6">
                  {messages.map((m, i) => (
                    <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      {m.role === "assistant" && <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center text-xs font-bold shrink-0 mt-1">✦</div>}
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words ${m.role === "user" ? "bg-[#212121] border border-[#2f2f2f] text-white" : "bg-transparent text-[#ececec]"}`}>
                        {m.role === "assistant" && m.metadata_json?.thinking && (
                          <details className="mb-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden">
                            <summary className="px-3 py-2 text-xs font-medium text-[#ab68ff] cursor-pointer select-none list-none">Thinking</summary>
                            <div className="px-3 pb-3 pt-1 text-xs leading-relaxed text-[#b4b4b4] whitespace-pre-wrap font-mono border-t border-[#1a1a1a]">{m.metadata_json.thinking}</div>
                          </details>
                        )}
                        <Markdown content={m.content} />
                        {m.role === "assistant" && m.metadata_json?.sources && m.metadata_json.sources.length > 0 && (
                          <details className="mt-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden">
                            <summary className="px-3 py-2 text-xs font-medium text-[#8e8e8e] cursor-pointer select-none list-none">
                              ▸ Sources <span className="bg-[#212121] border border-[#2f2f2f] rounded-full px-1.5 py-0.5 text-[11px]">{m.metadata_json.sources.length}</span>
                            </summary>
                            <div className="px-3 pb-3 space-y-2 border-t border-[#1a1a1a] pt-3">
                              {m.metadata_json.sources.slice(0, 6).map((s, j) => (
                                <div key={j} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3">
                                  <div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation}</div>
                                  <div className="text-sm mt-1 text-[#ececec] leading-relaxed">{s.snippet}</div>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        {m.metadata_json?.provider && (
                          <p className="mt-1 text-[11px] text-[#5f5f5f]">{m.metadata_json.provider}:{m.metadata_json.model}</p>
                        )}
                      </div>
                      {m.role === "user" && <div className="h-7 w-7 rounded-full bg-[#2f2f2f] text-white grid place-items-center text-xs shrink-0 mt-1">You</div>}
                    </div>
                  ))}
                  {messages.length === 0 && <div className="text-sm text-[#5f5f5f] text-center">No messages in this thread.</div>}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
