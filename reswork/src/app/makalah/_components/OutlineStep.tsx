"use client";

import { useMemo } from "react";
import { findOutlineOverlaps } from "@/lib/wb/makalah";
import { useMakalahWorkbench } from "./MakalahWorkbenchContext";
import { resolvedIds } from "./types";

/** STEP 2 - human review: edit, renumber, map sources and approve. */
export function OutlineStep() {
  const { draft } = useMakalahWorkbench();
  const {
    mode,
    outline,
    outlineLoading,
    outlineError,
    refineNote,
    coverageNotes,
    minSubs,
    maxSubs,
    selected,
    titleOf,
    runOutline,
    applyRefine,
    patchChapter,
    patchSub,
    moveSub,
    addSub,
    delSub,
    toggleSubSource,
    removeChapter,
    setApproved,
    setStep,
  } = draft;

  const outlineOverlaps = useMemo(() => findOutlineOverlaps(outline), [outline]);

  return (
    <div className="space-y-4">
      {mode === "A" && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => void runOutline()}
            disabled={outlineLoading}
            className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40"
          >
            {outlineLoading
              ? "Generating outline…"
              : outline.length
                ? "↻ Regenerate outline"
                : "Generate outline"}
          </button>
          {outline.length > 0 && !outlineLoading && (
            <button
              onClick={() => applyRefine()}
              className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white hover:bg-[#2f2f2f]"
              title="Hapus duplikat nomor/judul & dead-end tanpa sumber, lalu renumber. Jalankan sebelum drafting."
            >
              🧹 Bersihkan Outline
            </button>
          )}
          {outlineLoading && (
            <span className="text-xs text-[#8e8e8e]">LLM call #1 - structure only, no content yet.</span>
          )}
        </div>
      )}
      {mode === "B" && outline.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => applyRefine()}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white hover:bg-[#2f2f2f]"
            title="Hapus duplikat nomor/judul & dead-end tanpa sumber, lalu renumber. Jalankan sebelum drafting."
          >
            🧹 Bersihkan Outline
          </button>
        </div>
      )}
      {outlineError && (
        <div className="text-xs text-red-400 border border-red-900 bg-red-950/30 rounded-xl px-3 py-2">
          {outlineError}
        </div>
      )}
      {refineNote && (
        <div className="text-xs text-[#8e8e8e] border border-[#2f2f2f] bg-[#0a0a0a] rounded-xl px-3 py-2">
          {refineNote}
        </div>
      )}
      {coverageNotes && (
        <div className="text-xs text-[#8e8e8e] border border-[#2f2f2f] bg-[#0a0a0a] rounded-xl px-3 py-2">
          Coverage notes: {coverageNotes}
        </div>
      )}
      {outlineOverlaps.length > 0 && (
        <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">
          Kemungkinan tumpang tindih outline:{" "}
          {outlineOverlaps
            .slice(0, 3)
            .map((o) => `${o.a} ≈ ${o.b} (${o.score})`)
            .join(" · ")}
          {outlineOverlaps.length > 3 && ` (+${outlineOverlaps.length - 3} lainnya)`} - pertajam
          Fokus di bawah atau gabung sebelum drafting.
        </div>
      )}

      {outline.map((ch, ci) => (
        <div key={ci} className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
          <div className="flex gap-2 items-center">
            <input
              value={ch.chapter_number}
              onChange={(e) => patchChapter(ci, { chapter_number: e.target.value })}
              className="w-24 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
            <input
              value={ch.chapter_title}
              onChange={(e) => patchChapter(ci, { chapter_title: e.target.value })}
              className="flex-1 min-w-0 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
            {(ch.synthesis_only ?? (outline.length > 1 && ci === outline.length - 1)) && (
              <span
                className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-emerald-900 text-emerald-400"
                title="Bab sintesis: memakai ulang evidence yang sudah disitasi, tanpa bukti baru."
              >
                sintesis
              </span>
            )}
            <button
              onClick={() => removeChapter(ci)}
              className="text-xs text-red-400 px-2"
              title="Delete chapter"
              aria-label="Delete chapter"
            >
              ✕
            </button>
          </div>
          {(ch.subsections.length < minSubs || ch.subsections.length > maxSubs) && (
            <div className="text-[11px] text-amber-300">
              Constraint: {minSubs}–{maxSubs} subsections per chapter (now{" "}
              {ch.subsections.length}).
            </div>
          )}
          {ch.subsections.map((sub, si) => (
            <div key={si} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  value={sub.number}
                  onChange={(e) => patchSub(ci, si, { number: e.target.value })}
                  className="w-16 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white"
                />
                <input
                  value={sub.title}
                  onChange={(e) => patchSub(ci, si, { title: e.target.value })}
                  placeholder="Subsection title…"
                  className="flex-1 min-w-0 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white"
                />
                <button
                  onClick={() => moveSub(ci, si, -1)}
                  aria-label="Move subsection up"
                  className="text-[#8e8e8e] hover:text-white text-xs px-1"
                >
                  ↑
                </button>
                <button
                  onClick={() => moveSub(ci, si, 1)}
                  aria-label="Move subsection down"
                  className="text-[#8e8e8e] hover:text-white text-xs px-1"
                >
                  ↓
                </button>
                <button
                  onClick={() => delSub(ci, si)}
                  aria-label="Delete subsection"
                  className="text-red-400 text-xs px-1"
                >
                  ✕
                </button>
              </div>
              <input
                value={sub.focus ?? ""}
                onChange={(e) => patchSub(ci, si, { focus: e.target.value })}
                placeholder="Fokus - 1 kalimat: pertanyaan apa yang dijawab subbab ini? (dipakai untuk retrieval + anti-duplikasi)"
                className="w-full rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white placeholder:text-[#5f5f5f]"
              />
              {!sub.focus?.trim() && (
                <div className="text-[11px] text-amber-300/80">
                  tanpa fokus - retrieval sulit dibedakan dari subbab lain; isi 1 kalimat.
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {selected.map((id) => {
                  const on = resolvedIds(sub).includes(id);
                  return (
                    <button
                      key={id}
                      onClick={() => toggleSubSource(ci, si, id)}
                      title={titleOf(id)}
                      className={`rounded-full px-2.5 py-1 text-[11px] border ${
                        on
                          ? "bg-white text-black border-white"
                          : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e]"
                      }`}
                    >
                      {on ? "✓ " : ""}
                      {titleOf(id).slice(0, 28)}
                    </button>
                  );
                })}
                {!resolvedIds(sub).length && (
                  <span className="text-[11px] text-[#5f5f5f]">
                    no sources mapped - retrieval will search all selected docs
                  </span>
                )}
              </div>
            </div>
          ))}
          <button
            onClick={() => addSub(ci)}
            disabled={ch.subsections.length >= maxSubs}
            className="text-xs text-[#8e8e8e] hover:text-white disabled:opacity-40"
          >
            + Add subsection
          </button>
        </div>
      ))}

      <div className="flex gap-2 justify-between">
        <button
          onClick={() => setStep(1)}
          className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2.5 text-sm text-white"
        >
          ← Setup
        </button>
        <button
          onClick={() => {
            setApproved(true);
            setStep(3);
          }}
          disabled={
            !outline.length || outline.some((ch) => ch.subsections.some((s) => !s.title.trim()))
          }
          className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40"
        >
          Approve outline → drafting
        </button>
      </div>
    </div>
  );
}
