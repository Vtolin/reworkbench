"use client";

import { useState } from "react";
import { clearTraces, exportTrace, listTraces } from "@/lib/observability/trace";

// Dev/debug panel (Phase 7): reads the local in-memory trace collector —
// timings + counts for retrieve/rerank/llm steps. Never prompts, keys, or
// document content (steps have no such fields by construction).
export function TracePanel() {
  const [open, setOpen] = useState(false);
  // Bump to re-read the collector (traces accumulate outside React state).
  const [, setTick] = useState(0);
  const traces = open ? listTraces() : [];

  const copy = async (traceId: string) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportTrace(traceId), null, 2));
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-[#2f2f2f] bg-black p-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setOpen((v) => !v);
            setTick((t) => t + 1);
          }}
          className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white hover:bg-[#2f2f2f]"
        >
          {open ? "Hide operation traces" : "Show operation traces"}
        </button>
        {open && (
          <>
            <button
              onClick={() => setTick((t) => t + 1)}
              className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white hover:bg-[#2f2f2f]"
            >
              ↻ Refresh
            </button>
            <button
              onClick={() => {
                clearTraces();
                setTick((t) => t + 1);
              }}
              className="rounded-lg border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white hover:bg-[#2f2f2f]"
            >
              Clear
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-[#5f5f5f]">
            In-memory only, sent nowhere. Steps show timings + counts — never prompts, keys, or content.
          </div>
          {traces.length === 0 && <div className="text-xs text-[#5f5f5f]">No traces yet — run a search or ask.</div>}
          {traces.map((t) => (
            <div key={t.traceId} className="rounded-lg border border-[#2f2f2f] bg-[#171717] p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-white break-all">{t.traceId}</span>
                <span className="text-[11px] text-[#8e8e8e]">{t.totalMs}ms · {t.steps.length} steps</span>
                <button
                  onClick={() => copy(t.traceId)}
                  className="ml-auto rounded border border-[#2f2f2f] px-2 py-0.5 text-[11px] text-[#8e8e8e] hover:text-white"
                >
                  Copy
                </button>
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-[#b4b4b4]">
                {t.steps.map((s, i) => (
                  <div key={i}>
                    {s.step} — {s.ms}ms
                    {s.provider ? ` · ${s.provider}` : ""}
                    {s.model ? `:${s.model}` : ""}
                    {s.counts ? ` · ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
