"use client";

import Markdown from "@/components/Markdown";
import { isMalformedReference } from "@/lib/wb/makalah";
import { useMakalahWorkbench } from "./MakalahWorkbenchContext";

/** STEP 4 — quality report, bibliography editing, export and preview. */
export function ResultStep() {
  const { draft, exporter } = useMakalahWorkbench();
  const { quality, docTitle, isID, copied, exportNote } = exporter;
  const {
    hybridMode,
    references,
    flatByChapter,
    secs,
    titleOf,
    cover,
    setStep,
  } = draft;
  const {
    exportPDF,
    exportDOCX,
    copyMarkdown,
    publishToShared,
    refreshReferences,
    publishing,
    editingRef,
    setEditingRef,
    refEditText,
    setRefEditText,
    startEditRef,
    saveEditRef,
  } = exporter;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
        <div className="text-sm font-medium text-white">Quality report</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
            <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Structure</div>
            <div
              className={`text-sm font-semibold ${
                quality.structure_complete ? "text-emerald-400" : "text-amber-300"
              }`}
            >
              {quality.structure_complete ? "complete" : "incomplete"}
            </div>
          </div>
          <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
            <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Citations</div>
            <div className="text-sm font-semibold text-white">
              {quality.citation_total ? `${quality.citation_integrity_pct}%` : "—"}
            </div>
          </div>
          <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
            <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Issues</div>
            <div className="text-sm font-semibold text-white">
              {quality.unsupported_claims.length}
            </div>
          </div>
          <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
            <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">References</div>
            <div className="text-sm font-semibold text-white">{references.length}</div>
          </div>
        </div>
        {quality.unsupported_claims.length > 0 && (
          <div className="space-y-1">
            {quality.unsupported_claims.map((u, i) => (
              <div key={i} className="text-xs text-red-400">
                ✕ {u.subsection}: {u.reason}
              </div>
            ))}
          </div>
        )}
        {quality.citation_page_mismatches.length > 0 && (
          <div className="space-y-1">
            {quality.citation_page_mismatches.map((m, i) => (
              <div key={i} className="text-xs text-amber-300">
                ⚠ Page mismatch: {m} (page cited is not present in retrieved passages for this
                source)
              </div>
            ))}
          </div>
        )}
        {quality.missing_references.length > 0 && (
          <div className="text-xs text-amber-300">
            Missing metadata for: {quality.missing_references.map(titleOf).join(", ")}
          </div>
        )}
        {quality.malformed_references.length > 0 && (
          <div className="text-xs text-amber-300">
            Malformed bibliography entries — koreksi via Edit di Daftar Pustaka bawah (atau
            metadata sumber): {quality.malformed_references.map(titleOf).join(", ")}
          </div>
        )}
        {quality.unused_sources.length > 0 && (
          <div className="text-xs text-[#8e8e8e]">
            Selected but never cited: {quality.unused_sources.map(titleOf).join(", ")}
          </div>
        )}
        {quality.redundant_pairs.length > 0 && (
          <div className="text-xs text-amber-300">
            Kemungkinan duplikasi:{" "}
            {quality.redundant_pairs.map((p) => `${p.a} ≈ ${p.b} (${p.score})`).join(" · ")} —
            tekan ↻ Bukti baru pada section yang belakangan (atau pertajam Fokus).
          </div>
        )}
        {quality.ai_filled > 0 && hybridMode === "off" && (
          <div className="text-xs text-amber-300">
            {quality.ai_filled} paragraf tanpa sitasi dalam mode Strict — Regenerate dengan
            grounding 15/85, atau Edit manual.
          </div>
        )}
        {quality.ai_filled > 0 && hybridMode !== "off" && (
          <div className="text-xs text-[#8e8e8e]">
            {quality.ai_filled} paragraf model-bridged (tanpa sitasi) — wajar di mode {hybridMode};
            verifikasi manual sebelum final.
          </div>
        )}
        {quality.citation_missing_pages.length > 0 && (
          <div className="text-xs text-[#8e8e8e]">
            Tanpa halaman (sumbernya punya info halaman, sitasi membuangnya):{" "}
            {quality.citation_missing_pages.join(" · ")} — Regenerate atau tambah manual; bukan
            error, tapi melemahkan pinpoint.
          </div>
        )}
        <div className="flex gap-2 flex-wrap pt-1">
          <button
            onClick={() => void exportPDF()}
            className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium"
          >
            Export PDF (print)
          </button>{" "}
          <button
            onClick={() => void exportDOCX()}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
          >
            Export DOCX
          </button>{" "}
          <button
            onClick={() => void copyMarkdown()}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
          >
            {copied ? "✓ Copied" : "⧉ Copy Markdown"}
          </button>{" "}
          <button
            onClick={() => void publishToShared()}
            disabled={publishing}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white disabled:opacity-40"
            title="Publish this paper into Shared chats (same export gates as Copy/Export)"
          >
            {publishing ? "Publishing…" : "Publish to shared ↑"}
          </button>
          <button
            onClick={() => void refreshReferences()}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
          >
            ↻ Refresh references
          </button>
          <button
            onClick={() => setStep(3)}
            className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white"
          >
            ← Back to drafting
          </button>
        </div>
        {exportNote && <div className="text-xs text-amber-300">{exportNote}</div>}
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium text-white">Daftar Pustaka — {references.length} entri</div>
          <span className="text-[11px] text-[#5f5f5f]">
            otomatis dari metadata; klik Edit untuk isi/koreksi manual per entri. Refresh hanya
            menambah yang hilang, tidak menimpa editan.
          </span>
        </div>
        {!references.length && (
          <div className="text-xs text-[#5f5f5f]">
            Belum ada — Generate sections dulu, lalu Refresh references.
          </div>
        )}
        {references.map((r) => (
          <div key={r.id} className="rounded-xl bg-[#171717] border border-[#2f2f2f] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#5f5f5f] truncate flex-1" title={r.id}>
                {titleOf(r.id)}
              </span>
              {r.manual && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-emerald-900 text-emerald-400">
                  manual
                </span>
              )}
              {isMalformedReference(r.formatted_apa7) && !r.manual && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-800 text-amber-300">
                  perlu koreksi
                </span>
              )}
              {editingRef !== r.id && (
                <button
                  onClick={() => startEditRef(r)}
                  className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-0.5 bg-black"
                >
                  ✎ Edit
                </button>
              )}
            </div>
            {editingRef === r.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={refEditText}
                  onChange={(e) => setRefEditText(e.target.value)}
                  rows={3}
                  className="w-full rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 text-sm text-white"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setEditingRef(null)}
                    className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e]"
                  >
                    Batal
                  </button>
                  <button
                    onClick={() => saveEditRef(r.id)}
                    className="rounded-full bg-white text-black px-3 py-1 text-xs font-medium"
                  >
                    Simpan
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-[#b4b4b4] mt-1">{r.formatted_apa7}</div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-4">
        <h1 className="text-xl font-semibold text-white text-center">{docTitle}</h1>
        {(cover.author || cover.course) && (
          <div className="text-center text-xs text-[#8e8e8e]">
            {[
              cover.author && `${cover.author}${cover.nim ? ` — ${cover.nim}` : ""}`,
              cover.course,
              cover.lecturer,
            ]
              .filter(Boolean)
              .join(" • ")}
          </div>
        )}
        {flatByChapter.map(({ ch, items }, ci) => (
          <div key={ci}>
            <h2 className="text-base font-semibold text-white mt-2">
              {ch.chapter_number} {ch.chapter_title}
            </h2>
            {items.map((item) => {
              const st = secs[item.key];
              return (
                <div key={item.key} className="mt-2">
                  <h3 className="text-sm font-medium text-[#ececec]">
                    {item.sub.number} {item.sub.title}
                  </h3>
                  {st?.output ? (
                    <div className="text-sm text-[#b4b4b4] leading-relaxed space-y-2 mt-1">
                      {st.output.paragraphs.map((p, i) => (
                        <div key={i}>
                          <Markdown content={p.text} />
                          <div className="text-[11px] text-[#5f5f5f]">
                            {p.citations.map((c, j) => (
                              <span key={j} className="mr-2">
                                [{titleOf(c.source_id)}
                                {c.page ? `, h. ${c.page}` : ""}]
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-[#5f5f5f] italic">Belum dibuat.</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div>
          <h2 className="text-base font-semibold text-white mt-2">
            {isID ? "Daftar Pustaka" : "References"}
          </h2>
          <ol className="list-decimal ml-5 text-sm text-[#b4b4b4] space-y-1 mt-1">
            {references.map((r) => (
              <li key={r.id}>{r.formatted_apa7}</li>
            ))}
            {!references.length && <li className="text-[#5f5f5f]">No cited sources yet.</li>}
          </ol>
        </div>
      </div>
    </div>
  );
}
