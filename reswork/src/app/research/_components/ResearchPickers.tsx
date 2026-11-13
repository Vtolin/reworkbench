"use client";

import type { ReactNode } from "react";
import { toggleId } from "./ids";
import type { HybridMode, ResearchDoc } from "./types";

const pillOn = "bg-emerald-500/15 border-emerald-600 text-emerald-300 hover:bg-emerald-500/25";
const pillOff = "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e] hover:text-white";

/** One document chip, shared by every multi-document picker. */
export function DocChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-white bg-white text-black"
          : "border-[#2f2f2f] bg-[#171717] text-[#ececec] hover:bg-[#212121]"
      }`}
    >
      {children}
    </button>
  );
}

export function HybridSelect({
  value,
  onChange,
  className = "",
}: {
  value: HybridMode;
  onChange: (value: HybridMode) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as HybridMode)}
      className={`cursor-pointer rounded-full border text-xs font-medium outline-none transition ${
        value !== "off" ? pillOn : pillOff
      } ${className}`}
      title="Hybrid source: mix the documents with the model's training data. Low = 20/80 (mostly documents), Medium = 50/50, High = 80/20 (mostly training data), Maximum = training data only as primary source"
    >
      <option value="off" className="bg-[#171717] text-[#ececec]">
        Hybrid: Off
      </option>
      <option value="low" className="bg-[#171717] text-[#ececec]">
        Hybrid: Low (20/80)
      </option>
      <option value="medium" className="bg-[#171717] text-[#ececec]">
        Hybrid: Medium (50/50)
      </option>
      <option value="high" className="bg-[#171717] text-[#ececec]">
        Hybrid: High (80/20)
      </option>
      <option value="maximum" className="bg-[#171717] text-[#ececec]">
        Hybrid: Maximum
      </option>
    </select>
  );
}

function TogglePill({
  on,
  onClick,
  children,
  title,
  disabled = false,
  className = "",
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={() => {
        if (!disabled) onClick();
      }}
      disabled={disabled}
      className={`items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        disabled
          ? "cursor-not-allowed border-[#262626] bg-[#141414] text-[#5f5f5f] opacity-55"
          : on
            ? pillOn
            : pillOff
      } ${className}`}
      title={title}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          disabled ? "bg-[#4a4a4a]" : on ? "bg-emerald-400" : "bg-[#8e8e8e]"
        }`}
      />{" "}
      {children}
    </button>
  );
}

interface AskFlags {
  thinking: boolean;
  setThinking: (on: boolean) => void;
  memory: boolean;
  setMemory: (on: boolean) => void;
  webSearch: boolean;
  setWebSearch: (on: boolean) => void;
  webSearchReady: boolean;
  webSearchProviderLabel?: string;
  broad: boolean;
  setBroad: (on: boolean) => void;
  hybrid: HybridMode;
  setHybrid: (mode: HybridMode) => void;
  onClear: () => void;
}

/** Desktop ask toolbar: thinking / memory / web / hybrid / broad / clear. */
export function AskToolbar(flags: AskFlags) {
  const webTitle = flags.webSearchReady
    ? `Web search (${flags.webSearchProviderLabel || "BYOK"} + anti-slop filter): retrieve verified web sources alongside your library`
    : "Web search locked - save an API key in Settings → Web Search to enable live web retrieval";
  return (
    <>
      <TogglePill
        on={flags.thinking}
        onClick={() => flags.setThinking(!flags.thinking)}
        title="Thinking mode: model reasons step-by-step before answering. Toggle on for hypotheses."
        className="hidden sm:flex"
      >
        Thinking
      </TogglePill>
      <TogglePill
        on={flags.memory}
        onClick={() => flags.setMemory(!flags.memory)}
        title="Conversation memory: follow-up questions remember earlier answers"
        className="hidden sm:flex"
      >
        Memory
      </TogglePill>
      <TogglePill
        on={flags.webSearchReady && flags.webSearch}
        disabled={!flags.webSearchReady}
        onClick={() => flags.setWebSearch(!flags.webSearch)}
        title={webTitle}
        className="hidden sm:flex"
      >
        Web
      </TogglePill>
      <HybridSelect
        value={flags.hybrid}
        onChange={flags.setHybrid}
        className="hidden px-3 py-1.5 sm:block"
      />
      <label className="hidden cursor-pointer items-center gap-2 rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs sm:flex">
        <input type="checkbox" checked={flags.broad} onChange={(e) => flags.setBroad(e.target.checked)} className="accent-white" />
        <span className={flags.broad ? "text-white" : "text-[#8e8e8e]"}>Broad</span>
      </label>
      <button onClick={flags.onClear} className="hidden px-2 text-xs text-[#8e8e8e] hover:text-white sm:block">
        Clear chat
      </button>
    </>
  );
}

/** Compact ask flags shown inside the mobile scope drawer. */
export function AskMobileControls(flags: AskFlags) {
  const webTitle = flags.webSearchReady
    ? `Web search (${flags.webSearchProviderLabel || "BYOK"} + anti-slop filter)`
    : "Save a Web Search API key in Settings → Web Search to unlock";
  return (
    <div className="flex flex-wrap gap-2 xl:hidden">
      <TogglePill
        on={flags.thinking}
        onClick={() => flags.setThinking(!flags.thinking)}
        title="Thinking mode"
        className="flex min-w-[90px] flex-1 justify-center py-1.5"
      >
        Thinking
      </TogglePill>
      <TogglePill
        on={flags.memory}
        onClick={() => flags.setMemory(!flags.memory)}
        title="Conversation memory"
        className="flex min-w-[90px] flex-1 justify-center py-1.5"
      >
        Memory
      </TogglePill>
      <TogglePill
        on={flags.webSearchReady && flags.webSearch}
        disabled={!flags.webSearchReady}
        onClick={() => flags.setWebSearch(!flags.webSearch)}
        title={webTitle}
        className="flex min-w-[90px] flex-1 justify-center py-1.5"
      >
        Web
      </TogglePill>
      <label className="flex min-w-22.5 flex-1 items-center justify-center gap-2 rounded-full border border-[#2f2f2f] bg-[#212121] py-1.5 text-xs">
        <input type="checkbox" checked={flags.broad} onChange={(e) => flags.setBroad(e.target.checked)} /> Broad
      </label>
      <HybridSelect value={flags.hybrid} onChange={flags.setHybrid} className="w-full px-3 py-1.5" />
    </div>
  );
}

/** Ask-mode scope: collapsible on mobile, one scrollable row on xl. */
export function AskScopePicker({
  docs,
  selected,
  onChange,
  open,
  setOpen,
  children,
}: {
  docs: ResearchDoc[];
  selected: string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  children?: ReactNode;
}) {
  const labels = selected.map((id) => docs.find((d) => d.id === id)?.original_filename).join(", ");

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm xl:hidden"
      >
        <span className="flex items-center gap-2 text-[#ececec]">
          <span className="text-[#8e8e8e]">Scope:</span>
          <span className="font-medium">{selected.length === 0 ? "All docs" : `${selected.length} selected`}</span>
          {selected.length > 0 && (
            <span className="hidden max-w-[150px] truncate text-xs text-[#8e8e8e] sm:inline">- {labels}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {selected.length > 0 && <span className="h-2 w-2 rounded-full bg-white" />}
          <span className="text-xs text-[#8e8e8e]">{open ? "Hide ▴" : "Show ▾"}</span>
        </span>
      </button>

      <div className={`${open ? "flex" : "hidden"} mt-2 flex-col gap-2 xl:mt-0 xl:flex`}>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <div className="no-scrollbar flex flex-wrap items-center gap-1.5 py-1.5 xl:flex-nowrap xl:overflow-x-auto">
              <span className="mr-1 hidden shrink-0 text-xs text-[#8e8e8e] xl:inline">Scope:</span>
              <button
                onClick={() => onChange([])}
                className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
                  selected.length === 0
                    ? "border-white bg-white text-black"
                    : "border-[#2f2f2f] bg-[#171717] text-[#8e8e8e] hover:text-white"
                }`}
              >
                All docs
              </button>
              {docs.map((d) => (
                <DocChip key={d.id} active={selected.includes(d.id)} onClick={() => onChange(toggleId(selected, d.id))}>
                  {d.original_filename}
                </DocChip>
              ))}
              {selected.length > 0 && (
                <button
                  onClick={() => onChange([])}
                  className="whitespace-nowrap rounded-full border border-red-900/50 bg-[#171717] px-3 py-1 text-xs text-red-400"
                >
                  Clear ({selected.length})
                </button>
              )}
            </div>
            <div className="pointer-events-none absolute top-0 right-0 bottom-0 hidden w-10 bg-gradient-to-l from-black to-transparent xl:block" />
          </div>
          <span className="hidden shrink-0 text-[10px] text-[#5f5f5f] xl:inline">{docs.length} docs</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ComparePicker({
  docs,
  ids,
  onToggle,
  open,
  setOpen,
}: {
  docs: ResearchDoc[];
  ids: string[];
  onToggle: (id: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const labels = ids.map((id) => docs.find((d) => d.id === id)?.original_filename).join(", ");

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm xl:hidden"
      >
        <span className="flex items-center gap-2 text-[#ececec]">
          <span className="text-[#8e8e8e]">Compare:</span>
          <span className="font-medium">{ids.length === 0 ? "Select docs" : `${ids.length} selected`}</span>
          {ids.length > 0 && <span className="hidden max-w-[150px] truncate text-xs text-[#8e8e8e] sm:inline">- {labels}</span>}
        </span>
        <span className="shrink-0 text-xs text-[#8e8e8e]">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>
      <div className={`${open ? "flex" : "hidden"} mt-2 flex-wrap gap-1.5 xl:mt-0 xl:flex`}>
        {docs.map((d) => {
          const on = ids.includes(d.id);
          return (
            <DocChip key={d.id} active={on} onClick={() => onToggle(d.id)}>
              {d.original_filename} {on ? "✓" : ""}
            </DocChip>
          );
        })}
      </div>
    </div>
  );
}

/** Matrix and synthesis both need a plain multi-select row. */
export function DocPickerRow({
  label,
  docs,
  ids,
  onToggle,
  trailing,
}: {
  label: string;
  docs: ResearchDoc[];
  ids: string[];
  onToggle: (id: string) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-[#8e8e8e]">{label}:</span>
      {docs.map((d) => (
        <DocChip key={d.id} active={ids.includes(d.id)} onClick={() => onToggle(d.id)}>
          {d.original_filename}
        </DocChip>
      ))}
      {trailing}
    </div>
  );
}

export function SummarizePicker({
  docs,
  docId,
  onDocChange,
  loading,
  armed,
  exportingFmt,
  note,
  onSummarize,
  onExportPress,
}: {
  docs: ResearchDoc[];
  docId: string | null;
  onDocChange: (id: string | null) => void;
  loading: boolean;
  armed: "pdf" | "html" | "docx" | null;
  exportingFmt: "pdf" | "html" | "docx" | null;
  note: { ok: boolean; msg: string } | null;
  onSummarize: () => void;
  onExportPress: (fmt: "pdf" | "html" | "docx") => void;
}) {
  const armClass = (fmt: "pdf" | "html" | "docx") =>
    `rounded-xl border px-4 py-2 text-sm disabled:opacity-40 ${
      armed === fmt ? "border-white bg-white font-medium text-black" : "border-[#2f2f2f] bg-[#212121] text-white"
    }`;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={docId ?? ""}
          onChange={(e) => onDocChange(e.target.value || null)}
          className="min-w-[200px] flex-1 rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-sm text-white"
        >
          <option value="">Select a document to summarize</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.original_filename} - {d.title?.slice(0, 60) ?? ""}
            </option>
          ))}
        </select>
        <button
          onClick={onSummarize}
          disabled={!docId || loading}
          className="rounded-xl bg-white px-5 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {loading ? (armed ? `Summarizing + exporting ${armed.toUpperCase()}…` : "Summarizing…") : "Summarize"}
        </button>
        <button
          onClick={() => onExportPress("pdf")}
          disabled={!docId || loading || exportingFmt !== null}
          title={
            armed === "pdf"
              ? "Armed - PDF will export when summarization finishes (press again to disarm)"
              : "Arm PDF export for when summarization finishes"
          }
          className={armClass("pdf")}
        >
          {exportingFmt === "pdf" ? "Exporting…" : `Export PDF${armed === "pdf" ? " ✓" : ""}`}
        </button>
        <button
          onClick={() => onExportPress("html")}
          disabled={!docId || loading || exportingFmt !== null}
          title={
            armed === "html"
              ? "Armed - HTML will export when summarization finishes (press again to disarm)"
              : "Arm HTML export for when summarization finishes"
          }
          className={armClass("html")}
        >
          {exportingFmt === "html" ? "Exporting…" : `Export HTML${armed === "html" ? " ✓" : ""}`}
        </button>
        <button
          onClick={() => onExportPress("docx")}
          disabled={!docId || loading || exportingFmt !== null}
          title={
            armed === "docx"
              ? "Armed - Word (.docx) will export when summarization finishes (press again to disarm)"
              : "Arm Word (.docx) export for when summarization finishes"
          }
          className={armClass("docx")}
        >
          {exportingFmt === "docx" ? "Exporting…" : `Export DOCX${armed === "docx" ? " ✓" : ""}`}
        </button>
      </div>
      {note ? (
        <div
          className={`mt-2 rounded-xl border px-3 py-1.5 text-xs ${
            note.ok ? "border-emerald-900 bg-emerald-950/30 text-emerald-400" : "border-red-900 bg-red-950/30 text-red-400"
          }`}
        >
          {note.msg}
        </div>
      ) : null}
    </>
  );
}

export function HybridBanner({ mode }: { mode: HybridMode }) {
  if (mode === "off") return null;
  return (
    <>
      <div className="mt-3 hidden items-start gap-2 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-300 sm:flex">
        <span className="shrink-0">⚠</span>
        <span>
          Hybrid source is <b>on ({mode})</b>. When the documents don&apos;t contain the answer, the model will draw on its training
          data - and it <b>may hallucinate</b>. Verify critical claims against the cited sources.
        </span>
      </div>
      <details className="mt-2 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-300 sm:hidden">
        <summary className="cursor-pointer list-none select-none">⚠ Hybrid {mode} - may hallucinate ▸</summary>
        <div className="pt-1 leading-relaxed">
          When the documents don&apos;t contain the answer, the model draws on its training data. Verify critical claims against
          the cited sources.
        </div>
      </details>
    </>
  );
}
