"use client";
import { useEffect, useState } from "react";
import { useChat } from "@/contexts/ChatContext";
import { useSession } from "@/contexts/SessionContext";
import {
  listSharedChats, fetchSharedChat, publishConversation, publishedMap,
  type SharedChat,
} from "@/lib/wb/publish";

export default function ChatHistoryPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, activeId, selectConversation, deleteConversation, newConversation, clearActive, clearMemory, importConversation } = useChat();
  const { user } = useSession();
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"mine" | "shared">("mine");
  const [shared, setShared] = useState<SharedChat[]>([]);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [published, setPublished] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      setPublished(publishedMap());
    } catch {
      /* ignore */
    }
  }, []);

  const loadShared = async () => {
    setSharedLoading(true);
    try {
      setShared(await listSharedChats());
    } catch {
      setShared([]);
    } finally {
      setSharedLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "shared") loadShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(""), 2500); };

  const handleNew = () => {
    newConversation();
    // New chat gets a fresh conversation id, so its memory starts empty.
    onNavigate?.();
  };

  const handleClearChat = () => {
    clearActive();
    flash("Chat cleared");
  };

  const handleClearMemory = () => {
    // Memory is the conversation's own earlier messages (sent as context when
    // the Memory toggle is on). Clearing marks a cutoff; the visible chat stays.
    clearMemory();
    flash("Memory cleared");
  };

  const handlePublish = async (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    try {
      const chatId = await publishConversation(conv);
      setPublished((prev) => ({ ...prev, [convId]: chatId }));
      flash("Published to shared chats ✓");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Publish failed");
    }
  };

  const handleImport = async (chat: SharedChat) => {
    try {
      const { messages } = await fetchSharedChat(chat.id);
      importConversation(`Imported: ${chat.title}`, messages);
      flash("Imported — continue it here with your own model");
      onNavigate?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Import failed");
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="p-3 border-b border-[#2f2f2f] space-y-2">
        <button onClick={handleNew} className="w-full rounded-xl bg-white text-black py-2.5 text-sm font-medium hover:bg-[#ececec]">+ New chat</button>
        <div className="flex gap-1 p-1 bg-[#212121] rounded-xl border border-[#2f2f2f]">
          {(["mine", "shared"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-1 rounded-lg text-xs font-medium capitalize transition ${tab === t ? "bg-white text-black" : "text-[#8e8e8e] hover:text-white"}`}
            >
              {t === "mine" ? "My chats" : "Shared"}
            </button>
          ))}
        </div>
        {note && <div className="text-[11px] text-emerald-400 text-center">{note}</div>}
      </div>

      {tab === "mine" ? (
        <>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 no-scrollbar">
            {conversations.length === 0 && <div className="text-xs text-[#5f5f5f] p-3 text-center">No chats yet</div>}
            {conversations.map(c => (
              <div
                key={c.id}
                onClick={() => { selectConversation(c.id); onNavigate?.(); }}
                className={`group rounded-xl px-3 py-2.5 cursor-pointer border ${c.id === activeId ? "bg-[#212121] border-[#2f2f2f]" : "border-transparent hover:bg-[#171717]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#8e8e8e] shrink-0">◧</span>
                  <span className="text-sm truncate flex-1 text-[#ececec]">{c.title || "New chat"}</span>
                  {published[c.id] ? (
                    <span className="text-[10px] text-emerald-400 shrink-0" title="Published to shared chats">✓ shared</span>
                  ) : (
                    c.messages.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePublish(c.id); }}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2 py-0.5 shrink-0"
                        title="Publish this chat to shared chats for others to see"
                      >Publish ↑</button>
                    )
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.title || "New chat"}"? This cannot be undone.`)) deleteConversation(c.id); }}
                    className="opacity-0 group-hover:opacity-100 text-[#5f5f5f] hover:text-red-400 text-xs px-1"
                    title="Delete chat"
                  >✕</button>
                </div>
                <div className="text-[11px] text-[#5f5f5f] mt-0.5">
                  {c.messages.length} msg{c.messages.length === 1 ? "" : "s"} • {new Date(c.updatedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>

          <div className="p-3 border-t border-[#2f2f2f] space-y-2">
            <button onClick={handleClearChat} className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] py-2 text-xs text-[#ececec] hover:bg-[#2f2f2f]">Clear chat</button>
            <button onClick={handleClearMemory} className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] py-2 text-xs text-[#ececec] hover:bg-[#2f2f2f]">Clear memory</button>
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-2 space-y-1 no-scrollbar">
          <div className="px-2 py-1 text-[11px] text-[#5f5f5f]">Published research from the workspace. Import one to continue it here with your own model.</div>
          {sharedLoading && <div className="text-xs text-[#5f5f5f] p-3 text-center">Loading shared chats…</div>}
          {!sharedLoading && shared.length === 0 && <div className="text-xs text-[#5f5f5f] p-3 text-center">Nothing published yet</div>}
          {shared.map(c => (
            <div key={c.id} className="rounded-xl px-3 py-2.5 border border-transparent hover:bg-[#171717]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8e8e8e] shrink-0">◭</span>
                <span className="text-sm truncate flex-1 text-[#ececec]">{c.title}</span>
                <button
                  onClick={() => handleImport(c)}
                  className="text-[10px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2 py-0.5 shrink-0"
                  title="Import into my research chats"
                >Import ↓</button>
              </div>
              <div className="text-[11px] text-[#5f5f5f] mt-0.5">
                {user && c.owner_id === user.id ? "published by you" : "shared"} • {new Date(c.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
