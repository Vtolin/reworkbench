"use client";

import Markdown from "@/components/Markdown";
import type { StoredChatMessage } from "@/contexts/ChatContext";
import type { StreamStatusState, StreamingState } from "@/lib/research/askFlow";
import { statusLabel } from "./statuses";
import type { ChatSource, MatrixRow, Mode, TimedStatus } from "./types";

const EMPTY_COPY: Record<Mode, { title: string; body: string }> = {
  ask: {
    title: "What do you want to know?",
    body: "Ask any question against your library. Toggle Thinking for hypotheses or unanswerable questions - uses the model's built-in reasoning before answering.",
  },
  compare: {
    title: "Compare documents",
    body: "Select ≥2 documents and ask how they relate. Each is retrieved separately and labeled.",
  },
  summarize: {
    title: "Summarize a paper",
    body: "Pick a document. The pipeline classifies document type, extracts facts per chunk (map), consolidates (reduce), then writes a doc-type-aware narrative (synthesis). Verbatim figures and dates are extracted by regex - exact regardless of model output.",
  },
  matrix: {
    title: "Build a literature matrix",
    body: "Select documents and generate a matrix: paper, method, dataset, findings, limitations. Export to CSV, XLSX or Markdown.",
  },
  synthesis: {
    title: "Cross-paper synthesis",
    body: "Select ≥2 documents and ask what the literature agrees on, disagrees on, or where the gaps are - answers are attributed per source.",
  },
};

const ASK_EXAMPLES = [
  "What methodology was used in the 2024 papers?",
  "Summarize the key limitations across all documents",
  "Hypothesis: why does AI improve grading? (use thinking)",
  "Compare findings on student-teacher relationship",
];

export function EmptyState({ mode, onExample }: { mode: Mode; onExample: (text: string) => void }) {
  const copy = EMPTY_COPY[mode];
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-white text-xl text-black">✦</div>
      <h2 className="text-2xl font-semibold text-white">{copy.title}</h2>
      <p className="mt-2 max-w-md text-sm text-[#8e8e8e]">{copy.body}</p>
      {mode === "ask" && (
        <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          {ASK_EXAMPLES.map((example) => (
            <button
              key={example}
              onClick={() => onExample(example)}
              className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3 text-left text-sm text-[#ececec] hover:bg-[#212121]"
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface TranscriptProps {
  messages: StoredChatMessage[];
  loading: boolean;
  editingId: string | null;
  editText: string;
  onEditTextChange: (text: string) => void;
  onStartEdit: (message: StoredChatMessage) => void;
  onSaveEdit: (message: StoredChatMessage) => void;
  onCancelEdit: () => void;
  onRegenerate: (messageId: string) => void;
  onCopy: (id: string, text: string) => void;
  copiedId: string | null;
}

/** Persisted conversation messages (user edits, thinking, sources, actions). */
export function Transcript(props: TranscriptProps) {
  const { messages, loading, editingId, editText, copiedId } = props;

  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          {m.role === "assistant" && (
            <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-black">✦</div>
          )}
          <div
            className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words sm:max-w-[78%] ${
              m.role === "user"
                ? "border border-[#2f2f2f] bg-[#212121] text-white"
                : "bg-transparent text-[#ececec]"
            }`}
          >
            {m.role === "assistant" && m.thinking ? (
              <details className="group/thinking mb-3 overflow-hidden rounded-xl border border-[#2f2f2f] bg-[#0a0a0a]">
                <summary className="flex list-none cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-[#ab68ff] select-none">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[#ab68ff]" /> Thinking
                  <span className="hidden font-normal text-[#5f5f5f] sm:inline">- model reasoning</span>
                  <span className="ml-auto text-[#5f5f5f] transition-transform group-open/thinking:rotate-180">▾</span>
                </summary>
                <div className="border-t border-[#1a1a1a] px-3 pt-1 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#b4b4b4]">
                  {m.thinking}
                </div>
              </details>
            ) : null}

            {m.role === "user" && editingId === m.id ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => props.onEditTextChange(e.target.value)}
                  rows={3}
                  autoFocus
                  className="w-full resize-none rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={props.onCancelEdit}
                    className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e] hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => props.onSaveEdit(m)}
                    className="rounded-full bg-white px-3 py-1 text-xs font-medium text-black"
                  >
                    Save & regenerate
                  </button>
                </div>
              </div>
            ) : (
              <Markdown content={m.content} />
            )}

            {m.role === "assistant" && m.sources && m.sources.length > 0 ? (
              <details className="group/sources mt-3 overflow-hidden rounded-xl border border-[#2f2f2f] bg-[#0a0a0a]">
                <summary className="flex list-none cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-[#8e8e8e] select-none">
                  <span className="text-[#8e8e8e]">▸</span> Sources
                  <span className="rounded-full border border-[#2f2f2f] bg-[#212121] px-1.5 py-0.5 text-[11px] text-[#8e8e8e]">
                    {m.sources.length}
                  </span>
                  <span className="ml-auto text-[#5f5f5f] transition-transform group-open/sources:rotate-90">▸</span>
                </summary>
                <div className="space-y-2 border-t border-[#1a1a1a] px-3 pt-3 pb-3">
                  {m.sources.slice(0, 6).map((s: ChatSource, i: number) => (
                    <SourceCard key={i} source={s} />
                  ))}
                </div>
              </details>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="text-[11px] text-[#5f5f5f]">
                {new Date(m.timestamp).toLocaleTimeString()}
                {m.thinkingEnabled ? " • thinking" : ""}
                {m.broad ? " • broad" : ""}
                {m.hybridMode ? ` • hybrid ${m.hybridMode}` : ""}
                {m.stopped ? " • stopped" : ""}
              </div>
              {m.role === "assistant" && !m.stopped ? (
                <>
                  {m.type === "ask" && (
                    <button
                      onClick={() => props.onRegenerate(m.id)}
                      disabled={loading}
                      className="ml-auto rounded-full border border-[#2f2f2f] bg-[#171717] px-2.5 py-1 text-[11px] text-[#8e8e8e] hover:text-white disabled:opacity-40"
                      title="Regenerate this answer"
                    >
                      ↻ Regenerate
                    </button>
                  )}
                  <button
                    onClick={() => props.onCopy(m.id, m.content)}
                    className={`${m.type === "ask" ? "" : "ml-auto "}rounded-full border border-[#2f2f2f] bg-[#171717] px-2.5 py-1 text-[11px] text-[#8e8e8e] hover:text-white`}
                    title="Copy answer"
                  >
                    {copiedId === m.id ? "✓ Copied" : "⧉ Copy"}
                  </button>
                </>
              ) : null}
              {m.role === "user" && m.type === "ask" && editingId !== m.id ? (
                <button
                  onClick={() => props.onStartEdit(m)}
                  className="ml-auto rounded-full border border-[#2f2f2f] bg-[#171717] px-2.5 py-1 text-[11px] text-[#8e8e8e] hover:text-white"
                  title="Edit question - regenerates the answer"
                >
                  ✎ Edit
                </button>
              ) : null}
            </div>
          </div>
          {m.role === "user" && (
            <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#2f2f2f] text-xs text-white">You</div>
          )}
        </div>
      ))}
    </>
  );
}

function SourceCard({ source }: { source: ChatSource }) {
  return (
    <div className="rounded-xl border border-[#2f2f2f] bg-[#171717] p-3">
      <div className="font-mono text-xs break-all text-[#8e8e8e]">{source.citation}</div>
      <div className="mt-1 text-sm leading-relaxed text-[#ececec]">{source.snippet}</div>
    </div>
  );
}

export function MatrixPanel({
  rows,
  onExport,
}: {
  rows: MatrixRow[];
  onExport: (format: "csv" | "xlsx" | "md") => void;
}) {
  return (
    <div className="space-y-4 py-6">
      <div className="flex flex-wrap gap-2">
        {(["csv", "xlsx", "md"] as const).map((fmt) => (
          <button
            key={fmt}
            onClick={() => onExport(fmt)}
            className="rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white"
          >
            {fmt === "md" ? "Copy Markdown" : `Download ${fmt.toUpperCase()}`}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-[#2f2f2f]">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#171717] tracking-wider text-[#8e8e8e] uppercase">
            <tr>
              {["Paper", "Year", "Method", "Dataset", "Findings", "Limitations"].map((h) => (
                <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[#2f2f2f] align-top">
                <td className="px-3 py-2 text-white">{r.paper}</td>
                <td className="px-3 py-2 text-[#b4b4b4]">{r.year ?? ""}</td>
                <td className="px-3 py-2 text-[#ececec]">{r.method}</td>
                <td className="px-3 py-2 text-[#ececec]">{r.dataset}</td>
                <td className="px-3 py-2 text-[#ececec]">{r.findings}</td>
                <td className="px-3 py-2 text-[#ececec]">{r.limitations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SynthesisPanel({
  answer,
  onCopy,
  copied,
  onExportDocx,
}: {
  answer: string;
  onCopy: () => void;
  copied: boolean;
  onExportDocx?: () => void;
}) {
  return (
    <div className="py-6">
      <div className="mb-2 flex justify-end gap-2">
        {onExportDocx ? (
          <button
            onClick={onExportDocx}
            className="rounded-full border border-[#2f2f2f] bg-[#171717] px-2.5 py-1 text-[11px] text-[#8e8e8e] hover:text-white"
            title="Download synthesis as Word (.docx)"
          >
            Export DOCX
          </button>
        ) : null}
        <button
          onClick={onCopy}
          className="rounded-full border border-[#2f2f2f] bg-[#171717] px-2.5 py-1 text-[11px] text-[#8e8e8e] hover:text-white"
          title="Copy synthesis"
        >
          {copied ? "✓ Copied" : "⧉ Copy"}
        </button>
      </div>
      <div className="rounded-2xl border border-[#2f2f2f] bg-[#171717] px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-[#ececec]">
        <Markdown content={answer} />
      </div>
    </div>
  );
}

export function StreamingBubble({
  streaming,
  status,
  answer,
  thinking,
  elapsed,
}: {
  streaming: StreamingState;
  status: StreamStatusState | null;
  answer: string;
  thinking: string | null;
  elapsed: number;
}) {
  return (
    <div className="flex justify-start gap-3">
      <div className="mt-1 grid h-7 w-7 shrink-0 animate-pulse place-items-center rounded-full bg-white text-xs font-bold text-black">
        ✦
      </div>
      <div className="max-w-[85%] rounded-2xl border border-[#2f2f2f]/50 bg-transparent px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-[#ececec] sm:max-w-[78%]">
        {status && !answer && thinking === null ? (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#2f2f2f] bg-[#0a0a0a] px-3 py-2">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white" />
            <span className="text-xs text-[#b4b4b4]">{statusLabel(status)}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-[#5f5f5f]">{elapsed.toFixed(1)}s</span>
          </div>
        ) : null}
        {status?.stage === "processing_prompt" && (answer || thinking !== null) ? (
          <div className="mb-2 font-mono text-[11px] text-[#5f5f5f]">prompt processed in {elapsed.toFixed(1)}s</div>
        ) : null}
        {thinking !== null ? (
          <details open className="mb-3 overflow-hidden rounded-xl border border-[#2f2f2f] bg-[#0a0a0a]">
            <summary className="flex list-none cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-[#ab68ff] select-none">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#ab68ff]" /> Thinking
              <span className="hidden font-normal text-[#5f5f5f] sm:inline">- model reasoning</span>
              <span className="ml-auto h-1.5 w-1.5 animate-ping rounded-full bg-emerald-400" />
            </summary>
            <div className="border-t border-[#1a1a1a] px-3 pt-1 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#b4b4b4]">
              {thinking || "…"}
            </div>
          </details>
        ) : null}
        {answer ? (
          <span>
            {answer}
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-white" />
          </span>
        ) : thinking === null && !status ? (
          <span>
            {streaming.raw}
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-white" />
          </span>
        ) : (
          <span className="text-[#8e8e8e] italic">Thinking…</span>
        )}
        {streaming.sources && streaming.sources.length > 0 ? (
          <details className="mt-3 overflow-hidden rounded-xl border border-[#2f2f2f] bg-[#0a0a0a]">
            <summary className="flex list-none cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-[#8e8e8e] select-none">
              <span>▸</span> Sources
              <span className="rounded-full border border-[#2f2f2f] bg-[#212121] px-1.5 py-0.5 text-[11px]">
                {streaming.sources.length}
              </span>
            </summary>
            <div className="space-y-2 border-t border-[#1a1a1a] px-3 pt-3 pb-3">
              {streaming.sources.slice(0, 6).map((s, i) => (
                <SourceCard key={i} source={s} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function PipelineLoading({
  mode,
  thinkingOn,
  summarizeLoading,
  summarizeStatus,
  statusNow,
}: {
  mode: Mode;
  thinkingOn: boolean;
  summarizeLoading: boolean;
  summarizeStatus: TimedStatus | null;
  statusNow: number;
}) {
  return (
    <div className="flex gap-3">
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-black">✦</div>
      <div className="rounded-2xl border border-[#2f2f2f] bg-[#171717] px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-[#8e8e8e]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          {mode === "summarize" && summarizeStatus ? (
            <span>{statusLabel(summarizeStatus, "chunk")}</span>
          ) : mode === "summarize" && summarizeLoading ? (
            "Summarizing…"
          ) : thinkingOn ? (
            "Thinking…"
          ) : (
            "Searching & synthesizing…"
          )}
          {mode === "summarize" && summarizeStatus ? (
            <span className="ml-auto shrink-0 font-mono text-[11px] text-[#5f5f5f]">
              {Math.max(0, (statusNow - summarizeStatus.since) / 1000).toFixed(1)}s
            </span>
          ) : null}
        </div>
        {mode === "summarize" && summarizeStatus?.total != null && summarizeStatus.current != null ? (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#2f2f2f]">
            <div
              className="h-full rounded-full bg-white transition-all duration-300"
              style={{ width: `${Math.round((summarizeStatus.current / summarizeStatus.total) * 100)}%` }}
            />
          </div>
        ) : (
          mode !== "summarize" && <div className="thinking-shimmer mt-2 h-2 w-24 rounded-full" />
        )}
      </div>
    </div>
  );
}
