"use client";
import { useEffect, useState } from "react";
import { useChat } from "@/contexts/ChatContext";
import { useSession } from "@/contexts/SessionContext";
import {
  listSharedChats, fetchSharedChat, publishConversation, publishedMap,
  listStoredChats, uploadConversation, pushConversationUpdate, deleteStoredChat,
  type SharedChat,
} from "@/lib/wb/publish";

export default function ChatHistoryPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { conversations, activeId, selectConversation, deleteConversation, newConversation, clearActive, clearMemory, importConversation, markStored } = useChat();
  const { user } = useSession();
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"mine" | "stored" | "shared">("mine");
  const [shared, setShared] = useState<SharedChat[]>([]);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [stored, setStored] = useState<SharedChat[]>([]);
  const [storedLoading, setStoredLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
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
    } catch (e) {
      // Never fail silently here: an RLS/connection denial otherwise looks
      // exactly like "nobody shared anything".
      setShared([]);
      flash(e instanceof Error ? e.message : "Failed to load shared chats");
    } finally {
      setSharedLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "shared") loadShared();
    if (tab === "stored") loadStored();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(""), 2500); };

  const loadStored = async () => {
    setStoredLoading(true);
    try {
      setStored(await listStoredChats());
    } catch (e) {
      setStored([]);
      flash(e instanceof Error ? e.message : "Failed to load stored chats");
    } finally {
      setStoredLoading(false);
    }
  };

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

  // Stored chats (hybrid opt-in sync): Local conversations stay on this
  // device; Store uploads a private account copy, Sync re-pushes it
  // (last writer wins), Download pulls it onto this device and links it.
  const handleStore = async (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv || busyId) return;
    setBusyId(`store:${convId}`);
    try {
      const chatId = await uploadConversation(conv);
      markStored(convId, chatId);
      if (tab === "stored") await loadStored();
      flash("Stored to your account ✓");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Store failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleSync = async (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv?.cloudId || busyId) return;
    setBusyId(`sync:${convId}`);
    try {
      await pushConversationUpdate(conv.cloudId, conv);
      flash("Synced ✓");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (chat: SharedChat) => {
    if (busyId) return;
    const linked = conversations.find((c) => c.cloudId === chat.id);
    if (linked) {
      selectConversation(linked.id);
      onNavigate?.();
      return;
    }
    setBusyId(`dl:${chat.id}`);
    try {
      const { messages } = await fetchSharedChat(chat.id);
      importConversation(chat.title, messages, chat.id);
      flash("Downloaded + linked — Sync pushes changes back");
      onNavigate?.();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteStored = async (chat: SharedChat) => {
    if (busyId) return;
    if (!confirm(`Delete stored copy "${chat.title}" from your account? Local chats stay untouched.`)) return;
    setBusyId(`rm:${chat.id}`);
    try {
      await deleteStoredChat(chat.id);
      const linked = conversations.find((c) => c.cloudId === chat.id);
      if (linked) markStored(linked.id, null);
      await loadStored();
      flash("Stored copy deleted");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="p-2 sm:p-3 border-b border-[#2f2f2f] space-y-2">
        <button onClick={handleNew} className="w-full rounded-xl bg-white text-black py-2 sm:py-2.5 text-[13px] sm:text-sm font-medium hover:bg-[#ececec]">+ New chat</button>
          <div className="flex gap-1 p-1 bg-[#212121] rounded-xl border border-[#2f2f2f]">
            {(["mine", "stored", "shared"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-1 rounded-lg text-xs font-medium capitalize transition ${tab === t ? "bg-white text-black" : "text-[#8e8e8e] hover:text-white"}`}
              >
                {t === "mine" ? "My chats" : t === "stored" ? "Stored" : "Shared"}
              </button>
            ))}
          </div>
        {note && <div className="text-[11px] text-emerald-400 text-center">{note}</div>}
      </div>

      {tab === "mine" ? (
        <>
          <div className="flex-1 overflow-y-auto p-1 sm:p-2 space-y-1 no-scrollbar">
            {conversations.length === 0 && <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">No chats yet</div>}
            {conversations.map(c => (
              <div
                key={c.id}
                onClick={() => { selectConversation(c.id); onNavigate?.(); }}
                className={`group rounded-xl px-2 sm:px-3 py-2 sm:py-2.5 cursor-pointer border ${c.id === activeId ? "bg-[#212121] border-[#2f2f2f]" : "border-transparent hover:bg-[#171717]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#8e8e8e] shrink-0">◧</span>
                  <span className="text-[13px] sm:text-sm truncate flex-1 text-[#ececec]">{c.title || "New chat"}</span>
                  {c.cloudId ? (
                    <span className="text-[10px] text-sky-400 shrink-0" title="Synced to your account — visible on your other devices">● stored</span>
                  ) : null}
                  {c.messages.length > 0 && !published[c.id] && (
                    c.cloudId ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSync(c.id); }}
                        disabled={busyId === `sync:${c.id}`}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2 py-0.5 shrink-0 disabled:opacity-40"
                        title="Push this device's version to your stored account copy (last writer wins)"
                      >{busyId === `sync:${c.id}` ? "…" : "Sync ↑"}</button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStore(c.id); }}
                        disabled={busyId === `store:${c.id}`}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2 py-0.5 shrink-0 disabled:opacity-40"
                        title="Upload a private copy to your account — visible on your other devices"
                      >{busyId === `store:${c.id}` ? "…" : "Store +"}</button>
                    )
                  )}
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

          <div className="p-2 sm:p-3 border-t border-[#2f2f2f] space-y-2">
            <button onClick={handleClearChat} className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] py-2 text-xs text-[#ececec] hover:bg-[#2f2f2f]">Clear chat</button>
            <button onClick={handleClearMemory} className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] py-2 text-xs text-[#ececec] hover:bg-[#2f2f2f]">Clear memory</button>
          </div>
        </>
      ) : tab === "stored" ? (
        <div className="flex-1 overflow-y-auto p-1 sm:p-2 space-y-1 no-scrollbar">
          <div className="px-2 py-1 text-[11px] text-[#5f5f5f]">Private account copies. Download one to continue it here — Sync pushes this device&apos;s version back.</div>
          {storedLoading && <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">Loading stored chats…</div>}
          {!storedLoading && stored.length === 0 && <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">Nothing stored — use Store + on a chat</div>}
          {stored.map(c => {
            const linked = conversations.some((l) => l.cloudId === c.id);
            return (
              <div key={c.id} className="rounded-xl px-2 sm:px-3 py-2 sm:py-2.5 border border-transparent hover:bg-[#171717]">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-sky-400 shrink-0">◈</span>
                  <span className="text-[13px] sm:text-sm truncate flex-1 text-[#ececec]">{c.title}</span>
                  {linked && <span className="text-[10px] text-sky-400 shrink-0">on this device</span>}
                  <button
                    onClick={() => handleDownload(c)}
                    disabled={busyId === `dl:${c.id}`}
                    className="text-[10px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2 py-0.5 shrink-0 disabled:opacity-40"
                    title={linked ? "Open the linked local copy" : "Download into my chats and link it"}
                  >{busyId === `dl:${c.id}` ? "…" : linked ? "Open" : "Download ↓"}</button>
                  <button
                    onClick={() => handleDeleteStored(c)}
                    disabled={busyId === `rm:${c.id}`}
                    className="text-[#5f5f5f] hover:text-red-400 text-xs px-1 disabled:opacity-40"
                    title="Delete stored copy (local chats stay untouched)"
                  >✕</button>
                </div>
                <div className="text-[11px] text-[#5f5f5f] mt-0.5">
                  stored • {new Date(c.created_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-1 sm:p-2 space-y-1 no-scrollbar">
          <div className="px-2 py-1 text-[11px] text-[#5f5f5f]">Published research from the workspace. Import one to continue it here with your own model.</div>
          {sharedLoading && <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">Loading shared chats…</div>}
          {!sharedLoading && shared.length === 0 && <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">Nothing published yet</div>}
          {shared.map(c => (
            <div key={c.id} className="rounded-xl px-3 py-2.5 border border-transparent hover:bg-[#171717]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8e8e8e] shrink-0">◭</span>
                <span className="text-[13px] sm:text-sm truncate flex-1 text-[#ececec]">{c.title}</span>
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
