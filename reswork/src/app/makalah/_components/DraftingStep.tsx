"use client";

import Markdown from "@/components/Markdown";
import { useMakalahRunner } from "@/components/useMakalahRunner";
import {
  SECTION_SALVAGE_MARKER,
  validateSectionCitations,
  type MakalahHybrid,
  type SectionOutput,
} from "@/lib/wb/makalah";
import { useMakalahWorkbench } from "./MakalahWorkbenchContext";
import { overlapNote } from "./roles";
import { freshSec, resolvedIds } from "./types";

/** STEP 3 — per-section generation, edit, claim check and preview gate. */
export function DraftingStep() {
  const { draft, gen, exporter } = useMakalahWorkbench();
  const {
    approved,
    hybridMode,
    setHybridMode,
    flat,
    outline,
    secs,
    setSec,
    selected,
    titleOf,
  } = draft;
  const { running, runNote, autoRetryDup, setAutoRetryDup, runOne, runAll, stopAll, regenFresh } =
    gen;

  // Claim-check runner lives in useMakalahRunner (Phase 6): concurrent
  // paragraph pipeline with injectable classifier; matching + failure rules
  // pinned by claimRunner.test.ts.
  const { runClaimCheck } = useMakalahRunner({
    getSection: (key) => secs[key],
    setSec,
  });

  return (
    <div className="space-y-4">
      {!approved && (
        <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">
          Outline was edited after approval — review it in step 2, then approve again before
          drafting.
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => void runAll()}
          disabled={running || !approved}
          className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40"
        >
          {running ? "Drafting…" : "Generate all sections"}
        </button>
        <label
          className="flex items-center gap-1.5 rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-xs text-[#ececec]"
          title="Saat Generate-all: tiap section yang terdeteksi duplikat (>0.88, Penutup >0.94) otomatis di-retry SEKALI dengan evidence baru + daftar kalimat terlarang. Untuk batch tanpa pengawasan."
        >
          <input
            type="checkbox"
            checked={autoRetryDup}
            onChange={(e) => setAutoRetryDup(e.target.checked)}
            disabled={running}
            className="accent-white"
          />
          Auto-retry duplikat 1×
        </label>
        <select
          value={hybridMode}
          onChange={(e) => setHybridMode(e.target.value as MakalahHybrid)}
          disabled={running}
          className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-xs text-white outline-none disabled:opacity-40"
          title="Grounding mode untuk drafting"
        >
          <option value="off" className="bg-[#171717]">
            Strict (100% sumber)
          </option>
          <option value="15/85" className="bg-[#171717]">
            15/85 transisi
          </option>
          <option value="30/70" className="bg-[#171717]">
            30/70 sintesis
          </option>
        </select>
        {running && (
          <button
            onClick={stopAll}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
          >
            ■ Stop (keep partial)
          </button>
        )}
        <button
          onClick={() => void exporter.openPreview()}
          className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
        >
          Preview →
        </button>
      </div>
      {runNote && <div className="text-xs text-[#8e8e8e]">{runNote}</div>}

      {flat.map((item) => {
        const st = secs[item.key] ?? freshSec();
        return (
          <div
            key={item.key}
            className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-white min-w-0 wrap-break-word flex-1 basis-40">
                {item.sub.number} {item.sub.title}
              </span>
              <span
                className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border ${
                  st.status === "ok"
                    ? "text-emerald-400 border-emerald-900"
                    : st.status === "error"
                      ? "text-red-400 border-red-900"
                      : st.status === "idle"
                        ? "text-[#5f5f5f] border-[#2f2f2f]"
                        : "text-amber-300 border-amber-800"
                }`}
              >
                {st.status === "retrieving"
                  ? "retrieving…"
                  : st.status === "generating"
                    ? "generating…"
                    : st.status}
              </span>
              <button
                onClick={() => void runOne(item.key, item.ch.chapter_title, item.sub)}
                disabled={
                  running ||
                  st.status === "retrieving" ||
                  st.status === "generating" ||
                  !selected.length
                }
                title={!selected.length ? "Pilih minimal 1 sumber di Step 1" : undefined}
                className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40"
              >
                {st.status === "ok" ? "↻ Regenerate" : "Generate"}
              </button>
              {st.status === "ok" && (
                <button
                  onClick={() => void regenFresh(item.key, item.ch.chapter_title, item.sub)}
                  disabled={running}
                  title="Regenerate dengan evidence yang belum dipakai section lain + daftar kalimat terlarang dari section paling mirip. Deterministik (suhu tetap 0; bab sintesis memakai ulang evidence + suhu 0.3)."
                  className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40"
                >
                  ↻ Bukti baru
                </button>
              )}
            </div>
            <div className="text-[11px] text-[#5f5f5f]">
              {item.ch.chapter_number} {item.ch.chapter_title} • sources:{" "}
              {resolvedIds(item.sub).length
                ? resolvedIds(item.sub).map(titleOf).join(", ")
                : selected.length
                  ? "all selected"
                  : "⚠ no sources selected — pilih di Step 1"}
              {st.passages.length > 0 && ` • ${st.passages.length} passages`}
              {st.integrity && ` • citations ${st.integrity.valid}/${st.integrity.total} valid`}
              {st.integrity && st.integrity.badPages?.length > 0 && (
                <span className="text-amber-300">
                  {" "}
                  • {st.integrity.badPages.length} page mismatch
                </span>
              )}
              {(() => {
                const ov = overlapNote(flat, outline, secs, item.key);
                return ov ? (
                  <span className={ov.hot ? "text-amber-300" : ""}> • 🧬 {ov.text}</span>
                ) : null;
              })()}
            </div>
            {st.error && <div className="text-xs text-red-400">{st.error}</div>}
            {st.output?.gaps.includes(SECTION_SALVAGE_MARKER) && (
              <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">
                ⚠ Model didn&apos;t return JSON — raw text kept without citations. Press Regenerate
                (or switch to a stronger section model in Settings) and verify before keeping.
              </div>
            )}
            {st.integrity && st.integrity.badIds.length > 0 && (
              <div className="text-xs text-red-400">
                Hallucinated source id(s) rejected by validator: {st.integrity.badIds.join(", ")}
              </div>
            )}
            {st.integrity && st.integrity.badPages?.length > 0 && (
              <div className="text-xs text-amber-300">
                Citation page mismatch(es) (not found in retrieved passages):{" "}
                {st.integrity.badPages.join(", ")}
              </div>
            )}
            {st.output && !st.editing && (
              <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] px-4 py-3 text-sm leading-relaxed text-[#ececec] space-y-2">
                {st.output.paragraphs.map((p, i) => (
                  <div key={i}>
                    <Markdown content={p.text} />
                    <div className="text-[11px] text-[#8e8e8e] mt-1">
                      {p.citations.map((c, j) => (
                        <span key={j} className="mr-2">
                          [{titleOf(c.source_id)}
                          {c.page ? `, h. ${c.page}` : ""}]
                        </span>
                      ))}
                      {st.claims?.[i] && (
                        <span
                          className={`ml-1 px-1.5 py-0.5 rounded-full border ${
                            st.claims[i].verdict === "supported"
                              ? "text-emerald-400 border-emerald-900"
                              : "text-red-400 border-red-900"
                          }`}
                        >
                          {st.claims[i].verdict === "supported"
                            ? "✓ supported"
                            : "✕ not supported"}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {st.output.gaps && (
                  <div className="text-xs text-amber-300 border-t border-[#2f2f2f] pt-2">
                    Gap: {st.output.gaps}
                  </div>
                )}
              </div>
            )}
            {st.output && st.editing && (
              <div className="space-y-2">
                <textarea
                  value={st.editText}
                  onChange={(e) => setSec(item.key, { editText: e.target.value })}
                  rows={8}
                  className="w-full rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 text-sm text-white"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setSec(item.key, { editing: false })}
                    className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const parts = st.editText
                        .split(/\n\s*\n/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const origCites = st.output!.paragraphs.map((p) => p.citations);
                      // Only keep citations for paragraphs that still exist at
                      // the same index with identical text; net-new or rewritten
                      // paragraphs get [] (counted as model-bridged) instead of
                      // inherited cites.
                      const origTexts = st.output!.paragraphs.map((p) => p.text.trim());
                      const next: SectionOutput = {
                        gaps: st.output!.gaps,
                        paragraphs: parts.map((text, i) => ({
                          text,
                          citations: origTexts[i] === text ? (origCites[i] ?? []) : [],
                        })),
                      };
                      setSec(item.key, {
                        editing: false,
                        output: next,
                        // Citations/claims verified against the old text are
                        // meaningless now — recompute integrity, drop stale
                        // verdicts.
                        integrity: validateSectionCitations(next, st.passages),
                        claims: null,
                      });
                    }}
                    className="rounded-full bg-white text-black px-3 py-1 text-xs font-medium"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
            {st.output && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() =>
                    setSec(item.key, {
                      editing: !st.editing,
                      editText: st.output!.paragraphs.map((p) => p.text).join("\n\n"),
                    })
                  }
                  className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717]"
                >
                  ✎ {st.editing ? "Close editor" : "Edit text"}
                </button>
                <button
                  onClick={() => void runClaimCheck(item.key)}
                  disabled={st.claimBusy}
                  className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40"
                >
                  {st.claimBusy
                    ? st.claimProgress
                      ? `Checking ${st.claimProgress.current}/${st.claimProgress.total}…`
                      : "Checking…"
                    : "Run claim-support check"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
