"use client";
import { useState } from "react";
import { useChat } from "@/contexts/ChatContext";
import { api } from "@/lib/api";

export default function ChatHistoryPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, activeId, selectConversation, deleteConversation, newConversation, clearActive } = useChat();
  const [note, setNote] = useState("");

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(""), 2000); };

  const handleNew = () => {
    newConversation();
    // New chat gets a fresh session id, so its backend memory starts empty.
    // Nothing to clear: the old global clear-all would have wiped every chat.
    onNavigate?.();
  };

  const handleClearChat = () => {
    clearActive();
    flash("Chat cleared");
  };

  const handleClearMemory = async () => {
    try { await api.clearMemory(activeId ?? undefined); flash("Memory cleared"); } catch { flash("Failed to clear memory"); }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="p-3 border-b border-[#2f2f2f]">
        <button onClick={handleNew} className="w-full rounded-xl bg-white text-black py-2.5 text-sm font-medium hover:bg-[#ececec]">+ New chat</button>
        {note && <div className="mt-2 text-[11px] text-emerald-400 text-center">{note}</div>}
      </div>

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
              <button
                onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); api.clearMemory(c.id).catch(()=>{}); }}
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
    </div>
  );
}
