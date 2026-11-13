"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useChat, type StoredChatMessage } from "@/contexts/ChatContext";
import { useInference } from "@/contexts/InferenceContext";
import ChatHistoryPanel from "@/components/ChatHistoryPanel";
import { parseThinking } from "@/lib/research/streaming";
import { useAskStream } from "@/components/useAskStream";
import { toProviderMessages } from "@/lib/ai/types";
import { copyText } from "@/lib/browser/clipboard";
import { useResearchActions } from "./_components/useResearchActions";
import {
  AskMobileControls,
  AskScopePicker,
  AskToolbar,
  ComparePicker,
  DocPickerRow,
  HybridBanner,
  SummarizePicker,
} from "./_components/ResearchPickers";
import {
  EmptyState,
  MatrixPanel,
  PipelineLoading,
  StreamingBubble,
  SynthesisPanel,
  Transcript,
} from "./_components/ResearchTranscript";
import { ResearchComposer } from "./_components/ResearchComposer";
import { statusLabel } from "./_components/statuses";
import type { HybridMode, Mode, ResearchDoc } from "./_components/types";

const MODES: Mode[] = ["ask", "compare", "summarize", "matrix", "synthesis"];

export default function ResearchPage() {
  const [docs, setDocs] = useState<ResearchDoc[]>([]);
  const [mode, setMode] = useState<Mode>("ask");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [broad, setBroad] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [memoryOn, setMemoryOn] = useState(true);
  const [hybridMode, setHybridMode] = useState<HybridMode>("off");
  const [scopeOpenMobile, setScopeOpenMobile] = useState(false);
  const [compareOpenMobile, setCompareOpenMobile] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());

  const { activeConversation, addMessage, updateMessage, truncateAfter, clearActive, clearMemory, memoryCutoff } = useChat();
  const { settings } = useInference();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // Ask-stream orchestration lives in useAskStream; the non-streaming
  // compare/summarize/matrix/synthesis pipelines live in useResearchActions.
  const { streaming, streamStatus, loading, sendAsk, stop } = useAskStream({
    addMessage,
    focusInput: () => setTimeout(() => inputRef.current?.focus(), 100),
  });
  const actions = useResearchActions({ docs, addMessage, setAutoFollow });

  useEffect(() => {
    api
      .listDocuments({})
      .then((r) => setDocs(r.documents))
      .catch(() => {});
  }, []);

  // Elapsed-time ticker while a status (retrieving / loading / processing)
  // is shown.
  useEffect(() => {
    if (!streamStatus && !actions.summarize.status) return;
    // poll-ok: local elapsed-time clock, zero network/DB.
    const id = setInterval(() => setStatusNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [streamStatus, actions.summarize.status]);

  // Memory = this conversation's own earlier messages (after any clear-memory
  // cutoff), sent as context when the Memory toggle is on.
  const memoryMessages = (() => {
    if (!memoryOn || !activeConversation) return [];
    const cutoff = memoryCutoff(activeConversation.id);
    return toProviderMessages(
      activeConversation.messages
        .filter((m) => m.timestamp > cutoff && (m.role === "user" || m.role === "assistant"))
        .slice(-6),
    );
  })();

  // Only auto-scroll while the user is near the bottom (they can scroll up
  // mid-generation).
  useEffect(() => {
    if (autoFollow) chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    activeConversation?.messages.length,
    streaming?.answer,
    streaming?.thinking,
    loading,
    actions.summarize.loading,
    actions.compare.loading,
    autoFollow,
  ]);

  const handleMainScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom !== autoFollow) setAutoFollow(nearBottom);
  };

  const messages = activeConversation?.messages ?? [];

  const ask = async () => {
    if (!q.trim() || loading) return;
    const query = q;
    setQ("");
    await sendAsk(query, { scopeIds: selected, broad, thinking: thinkingMode, hybrid: hybridMode, memory: memoryOn, memoryMessages });
  };

  // Regenerate the answer for a given assistant message (re-runs its prompt).
  const regenerate = async (assistantMsgId: string) => {
    if (loading) return;
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx < 0) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userMsg = messages[userIdx];
    truncateAfter(userMsg.id);
    await sendAsk(
      userMsg.content,
      {
        scopeIds: userMsg.scopeIds ?? [],
        broad: userMsg.broad ?? false,
        thinking: userMsg.thinkingEnabled ?? false,
        hybrid: userMsg.hybridMode ?? "off",
        memory: memoryOn,
        memoryMessages,
      },
      { skipUserMessage: true },
    );
  };

  const startEdit = (m: StoredChatMessage) => {
    setEditingId(m.id);
    setEditText(m.content);
  };

  const saveEdit = async (m: StoredChatMessage) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text) return;
    updateMessage(m.id, { content: text });
    truncateAfter(m.id);
    await sendAsk(
      text,
      {
        scopeIds: m.scopeIds ?? [],
        broad: m.broad ?? false,
        thinking: m.thinkingEnabled ?? false,
        hybrid: m.hybridMode ?? "off",
        memory: memoryOn,
        memoryMessages,
      },
      { skipUserMessage: true },
    );
  };

  const copyToClipboard = async (id: string, text: string) => {
    if (!(await copyText(text))) return;
    setCopiedId(id);
    setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 2000);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (mode === "ask") void ask();
    else if (mode === "compare") void actions.compare.run();
    else if (mode === "synthesis") void actions.synthesis.run();
  };

  // The legacy <think> fallback for models that stream reasoning inline.
  const streamLegacyParsed =
    thinkingMode && streaming && streaming.thinking === null && streaming.raw.toLowerCase().includes("<think>")
      ? parseThinking(streaming.raw)
      : null;
  const streamThinking = streamLegacyParsed ? streamLegacyParsed.thinking : (streaming?.thinking ?? null);
  const streamAnswer = streamLegacyParsed ? streamLegacyParsed.answer : (streaming?.answer ?? "");
  const statusElapsed = streamStatus ? Math.max(0, (statusNow - streamStatus.since) / 1000) : 0;

  const askFlags = {
    thinking: thinkingMode,
    setThinking: setThinkingMode,
    memory: memoryOn,
    setMemory: setMemoryOn,
    broad,
    setBroad,
    hybrid: hybridMode,
    setHybrid: setHybridMode,
    onClear: () => {
      clearActive();
      clearMemory();
    },
  };

  const showPipelineLoading =
    (loading && !streaming) || actions.compare.loading || actions.summarize.loading;

  return (
    <div className="relative mt-[56px] flex h-[calc(100dvh-56px)] overflow-hidden bg-black text-[#ececec] lg:mt-0 lg:h-screen">
      {/* History drawer always overlays (never pushes) so it cannot collapse
          the chat when the sidebar width changes. */}
      {historyOpen ? (
        <div className="absolute inset-0 z-20 flex">
          <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[#2f2f2f] bg-[#0a0a0a] shadow-2xl">
            <ChatHistoryPanel onNavigate={() => setHistoryOpen(false)} />
          </aside>
          <button className="flex-1 bg-black/60 backdrop-blur-[1px]" onClick={() => setHistoryOpen(false)} aria-label="close history" />
        </div>
      ) : null}

      <div className="relative z-0 flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Header is static (not sticky) so it never covers the first message. */}
        <header className="relative z-0 shrink-0 border-b border-[#2f2f2f] bg-black">
          <div className="mx-auto max-w-4xl px-4 py-3 lg:px-6">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setHistoryOpen(!historyOpen)}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border text-[#ececec] ${
                  historyOpen ? "border-white bg-white text-black" : "border-[#2f2f2f] bg-[#212121] hover:bg-[#2f2f2f]"
                }`}
                title="Chat history"
              >
                ☰
              </button>

              <div className="no-scrollbar flex max-w-full min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl border border-[#2f2f2f] bg-[#212121] p-1">
                {MODES.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap capitalize transition sm:px-4 sm:text-sm ${
                      mode === m ? "bg-white text-black" : "text-[#8e8e8e] hover:text-white"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <div className="ml-auto flex items-center gap-2">{mode === "ask" ? <AskToolbar {...askFlags} /> : null}</div>
            </div>

            {mode === "ask" ? (
              <AskScopePicker
                docs={docs}
                selected={selected}
                onChange={setSelected}
                open={scopeOpenMobile}
                setOpen={setScopeOpenMobile}
              >
                <AskMobileControls {...askFlags} />
              </AskScopePicker>
            ) : null}

            {mode === "compare" ? (
              <ComparePicker
                docs={docs}
                ids={actions.compare.ids}
                onToggle={actions.compare.toggle}
                open={compareOpenMobile}
                setOpen={setCompareOpenMobile}
              />
            ) : null}

            {mode === "summarize" ? (
              <SummarizePicker
                docs={docs}
                docId={actions.summarize.docId}
                onDocChange={actions.summarize.setDocId}
                loading={actions.summarize.loading}
                armed={actions.summarize.armed}
                exportingFmt={actions.summarize.exportingFmt}
                note={actions.summarize.note}
                onSummarize={actions.summarize.run}
                onExportPress={actions.summarize.pressExport}
              />
            ) : null}

            {mode === "matrix" ? (
              <DocPickerRow
                label="Docs"
                docs={docs}
                ids={actions.matrix.ids}
                onToggle={actions.matrix.toggle}
                trailing={
                  <button
                    onClick={actions.matrix.run}
                    disabled={actions.matrix.ids.length < 1 || actions.matrix.loading}
                    className="ml-auto rounded-xl bg-white px-5 py-2 text-sm font-medium text-black disabled:opacity-40"
                  >
                    {actions.matrix.loading ? "Building…" : "Build matrix"}
                  </button>
                }
              />
            ) : null}

            {mode === "synthesis" ? (
              <DocPickerRow
                label="Docs"
                docs={docs}
                ids={actions.synthesis.ids}
                onToggle={actions.synthesis.toggle}
                trailing={<span className="text-xs text-[#5f5f5f]">pick ≥2, then ask below</span>}
              />
            ) : null}

            {mode === "ask" ? <HybridBanner mode={hybridMode} /> : null}
          </div>
        </header>

        {/* Chat is the only scroll container. */}
        <main ref={mainRef} onScroll={handleMainScroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!autoFollow ? (
            <button
              onClick={() => {
                setAutoFollow(true);
                chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="absolute right-6 bottom-4 z-10 grid h-10 w-10 place-items-center rounded-full bg-white text-black shadow-xl hover:bg-[#ececec]"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <span className="text-base font-bold">↓</span>
            </button>
          ) : null}

          <div className="mx-auto w-full max-w-3xl px-4 lg:px-0">
            {messages.length === 0 && !streaming ? (
              <EmptyState
                mode={mode}
                onExample={(example) => {
                  setQ(example);
                  setTimeout(() => inputRef.current?.focus(), 50);
                }}
              />
            ) : (
              <div className="space-y-6 py-6">
                <Transcript
                  messages={messages}
                  loading={loading}
                  editingId={editingId}
                  editText={editText}
                  onEditTextChange={setEditText}
                  onStartEdit={startEdit}
                  onSaveEdit={(m) => void saveEdit(m)}
                  onCancelEdit={() => setEditingId(null)}
                  onRegenerate={(id) => void regenerate(id)}
                  onCopy={(id, text) => void copyToClipboard(id, text)}
                  copiedId={copiedId}
                />

                {mode === "matrix" && actions.matrix.rows ? (
                  <MatrixPanel rows={actions.matrix.rows} onExport={(fmt) => void actions.matrix.exportRows(fmt)} />
                ) : null}

                {mode === "synthesis" && actions.synthesis.loading && actions.synthesis.status ? (
                  <div className="py-3">
                    <div className="flex items-center gap-2 rounded-xl border border-[#2f2f2f] bg-[#0a0a0a] px-3 py-2 text-xs text-[#b4b4b4]">
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white" />
                      <span>{statusLabel(actions.synthesis.status, "excerpt")}</span>
                    </div>
                  </div>
                ) : null}

                {mode === "synthesis" && actions.synthesis.answer ? (
                  <SynthesisPanel
                    answer={actions.synthesis.answer}
                    onCopy={() => void copyToClipboard("synth", actions.synthesis.answer ?? "")}
                    copied={copiedId === "synth"}
                    onExportDocx={() => void actions.synthesis.exportDocx()}
                  />
                ) : null}

                {streaming ? (
                  <StreamingBubble
                    streaming={streaming}
                    status={streamStatus}
                    answer={streamAnswer}
                    thinking={streamThinking}
                    elapsed={statusElapsed}
                  />
                ) : null}

                {showPipelineLoading ? (
                  <PipelineLoading
                    mode={mode}
                    thinkingOn={thinkingMode}
                    summarizeLoading={actions.summarize.loading}
                    summarizeStatus={actions.summarize.status}
                    statusNow={statusNow}
                  />
                ) : null}

                <div ref={chatEndRef} />
              </div>
            )}
          </div>
        </main>

        <ResearchComposer
          mode={mode}
          ask={{
            value: q,
            onChange: setQ,
            loading,
            streaming: !!streaming,
            onSend: () => void ask(),
            onStop: stop,
            selectedCount: selected.length,
          }}
          compare={{
            value: actions.compare.q,
            onChange: actions.compare.setQ,
            loading: actions.compare.loading,
            count: actions.compare.ids.length,
            onSend: () => void actions.compare.run(),
          }}
          synthesis={{
            value: actions.synthesis.q,
            onChange: actions.synthesis.setQ,
            loading: actions.synthesis.loading,
            count: actions.synthesis.ids.length,
            onSend: () => void actions.synthesis.run(),
          }}
          summarizeMethod={settings.summarizeMethod ?? "stuff"}
          thinkingOn={thinkingMode}
          memoryOn={memoryOn}
          hybridMode={hybridMode}
          settings={settings}
          inputRef={inputRef}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
