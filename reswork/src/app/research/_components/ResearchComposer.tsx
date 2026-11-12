"use client";

import type { KeyboardEvent, RefObject } from "react";
import type { InferenceSettings } from "@/contexts/InferenceContext";
import type { HybridMode, Mode } from "./types";

interface ComposerProps {
  mode: Mode;
  ask: {
    value: string;
    onChange: (value: string) => void;
    loading: boolean;
    streaming: boolean;
    onSend: () => void;
    onStop: () => void;
    selectedCount: number;
  };
  compare: {
    value: string;
    onChange: (value: string) => void;
    loading: boolean;
    count: number;
    onSend: () => void;
  };
  synthesis: {
    value: string;
    onChange: (value: string) => void;
    loading: boolean;
    count: number;
    onSend: () => void;
  };
  summarizeMethod: InferenceSettings["summarizeMethod"];
  thinkingOn: boolean;
  memoryOn: boolean;
  hybridMode: HybridMode;
  settings: InferenceSettings;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

const textareaClass =
  "flex-1 bg-transparent text-white placeholder:text-[#8e8e8e] text-[13px] sm:text-sm px-2 sm:px-3 py-2 sm:py-2.5 outline-none resize-none";

/** Fixed composer footer; each mode gets the input (or hint) it needs. */
export function ResearchComposer({
  mode,
  ask,
  compare,
  synthesis,
  summarizeMethod,
  thinkingOn,
  memoryOn,
  hybridMode,
  settings,
  inputRef,
  onKeyDown,
}: ComposerProps) {
  const sendButton =
    "h-9 w-9 sm:h-10 sm:w-10 grid place-items-center rounded-xl bg-white text-black disabled:opacity-40 disabled:cursor-not-allowed shrink-0";

  return (
    <footer className="shrink-0 border-t border-[#2f2f2f] bg-black pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-3xl px-2 py-2.5 sm:px-4 sm:py-4">
        {mode === "ask" ? (
          <div className="flex items-end gap-1.5 rounded-2xl border border-[#2f2f2f] bg-[#212121] p-1.5 focus-within:border-[#404040] sm:gap-2 sm:p-2">
            <textarea
              ref={inputRef}
              value={ask.value}
              onChange={(e) => ask.onChange(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                ask.selectedCount
                  ? `Ask the ${ask.selectedCount} selected document(s)… (Shift+Enter newline)`
                  : "Ask the library… (Shift+Enter newline)"
              }
              className={`${textareaClass} max-h-32 min-h-[40px] sm:min-h-[44px]`}
            />
            {ask.loading && ask.streaming ? (
              <button onClick={ask.onStop} className={sendButton} title="Stop generating">
                <span className="h-3.5 w-3.5 rounded-[3px] bg-black" />
              </button>
            ) : (
              <button onClick={ask.onSend} disabled={ask.loading || !ask.value.trim()} className={sendButton}>
                <span className="text-base sm:text-lg">↑</span>
              </button>
            )}
          </div>
        ) : null}

        {mode === "compare" ? (
          <div className="flex items-end gap-1.5 rounded-2xl border border-[#2f2f2f] bg-[#212121] p-1.5 sm:gap-2 sm:p-2">
            <textarea
              value={compare.value}
              onChange={(e) => compare.onChange(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={compare.count < 2 ? "Select ≥2 docs first" : "How do they differ on... (Shift+Enter newline)"}
              className={textareaClass}
            />
            <button onClick={compare.onSend} disabled={compare.loading || !compare.value.trim() || compare.count < 2} className={sendButton}>
              ↑
            </button>
          </div>
        ) : null}

        {mode === "summarize" ? (
          <div className="py-2 text-center text-xs text-[#8e8e8e]">
            Select a document above and click Summarize. Method:{" "}
            <span className="text-white">{summarizeMethod === "map_reduce" ? "map → reduce → synthesis" : "single-pass"}</span> •
            verbatim facts extracted by regex (change in Settings).
          </div>
        ) : null}

        {mode === "matrix" ? (
          <div className="py-2 text-center text-xs text-[#8e8e8e]">
            Select documents above and click Build matrix. Each row is extracted by your own model; export as CSV / XLSX /
            Markdown.
          </div>
        ) : null}

        {mode === "synthesis" ? (
          <div className="flex items-end gap-1.5 rounded-2xl border border-[#2f2f2f] bg-[#212121] p-1.5 sm:gap-2 sm:p-2">
            <textarea
              value={synthesis.value}
              onChange={(e) => synthesis.onChange(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                synthesis.count < 2
                  ? "Select ≥2 docs first"
                  : "What does the literature agree or disagree on? Where are the gaps? (Shift+Enter newline)"
              }
              className={textareaClass}
            />
            <button onClick={synthesis.onSend} disabled={synthesis.loading || !synthesis.value.trim() || synthesis.count < 2} className={sendButton}>
              ↑
            </button>
          </div>
        ) : null}

        <div className="mt-1.5 px-2 text-center text-[11px] text-[#5f5f5f] sm:mt-2">
          <span className="sm:hidden">
            {settings.provider === "ollama" ? settings.model : `${settings.cloudProvider}:${settings.cloudModel}`} •{" "}
            {thinkingOn ? "Think on" : "Think off"} • {memoryOn ? "Mem on" : "Mem off"} • {hybridMode !== "off" ? hybridMode : "Strict"}
          </span>
          <span className="hidden sm:inline">
            {settings.provider === "ollama" ? `${settings.model} • ${settings.numCtx} ctx` : `${settings.cloudProvider}:${settings.cloudModel}`} •
            Hybrid FTS+BM25+vector • Cross-encoder reranked • {thinkingOn ? "Thinking on" : "Thinking off"} •{" "}
            {memoryOn ? "Memory on" : "Memory off"} • {hybridMode !== "off" ? `Hybrid source ${hybridMode}` : "Strict grounding"}
          </span>
        </div>
      </div>
    </footer>
  );
}
