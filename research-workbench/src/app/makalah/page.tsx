"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useInference } from "@/contexts/InferenceContext";
import { useMakalah, blankSnapshot, type MakalahSnapshot } from "@/contexts/MakalahContext";
import Topbar from "@/components/Topbar";
import Markdown from "@/components/Markdown";
import MakalahHistoryPanel from "@/components/MakalahHistoryPanel";
import {
  validateSectionCitations,
  SECTION_SALVAGE_MARKER,
  type OutlineChapter,
  type OutlineSubsection,
  type SectionOutput,
  type SectionPassage,
  type MakalahReference,
  type QualityReport,
} from "@/lib/wb/makalah";

const DEFAULT_CHAPTERS = "BAB I Pendahuluan\nBAB II Pembahasan\nBAB III Penutup";

type SecStatus = "idle" | "retrieving" | "generating" | "ok" | "error";
interface SecState {
  status: SecStatus;
  passages: SectionPassage[];
  output: SectionOutput | null;
  error: string | null;
  integrity: { total: number; valid: number; badIds: string[] } | null;
  claims: Array<{ verdict: string; reason: string }> | null;
  claimBusy: boolean;
  editing: boolean;
  editText: string;
}
const freshSec = (): SecState => ({
  status: "idle", passages: [], output: null, error: null,
  integrity: null, claims: null, claimBusy: false, editing: false, editText: "",
});

const subKey = (chapter_number: string, number: string) => `${chapter_number}::${number}`;

function parseChapterLine(line: string, idx: number): { number: string; title: string } {
  const m = line.trim().match(/^(BAB\s+\S+)\s+([\s\S]*)$/i);
  if (m) return { number: m[1].toUpperCase(), title: (m[2] || line).trim() };
  return { number: `BAB ${idx + 1}`, title: line.trim() };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function MakalahPage() {
  const { settings } = useInference();
  const { drafts, activeId, hydrated, newDraft, selectDraft, saveDraft } = useMakalah();
  const [step, setStep] = useState(1);
  const [docs, setDocs] = useState<any[]>([]);
  // bound history draft (null until context hydrates) + drawer
  const [docId, setDocId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // setup
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("id-ID");
  const [academicLevel, setAcademicLevel] = useState("undergraduate");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"A" | "B">("A");
  const [chaptersText, setChaptersText] = useState(DEFAULT_CHAPTERS);
  const [minSubs, setMinSubs] = useState(2);
  const [maxSubs, setMaxSubs] = useState(5);
  const [targetWords, setTargetWords] = useState(300);
  const [citationStyle, setCitationStyle] = useState("APA 7");
  const [cover, setCover] = useState({ title: "", author: "", nim: "", course: "", lecturer: "" });

  // outline
  const [outline, setOutline] = useState<OutlineChapter[]>([]);
  const [coverageNotes, setCoverageNotes] = useState("");
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  // drafting
  const [secs, setSecs] = useState<Record<string, SecState>>({});
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const stopRef = useRef(false);

  // result
  const [references, setReferences] = useState<MakalahReference[]>([]);
  const [copied, setCopied] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  useEffect(() => { api.listDocuments({}).then((r) => setDocs(r.documents)).catch(() => {}); }, []);

  const titleOf = (id: string) =>
    docs.find((d) => d.id === id)?.title ||
    docs.find((d) => d.id === id)?.original_filename ||
    id.slice(0, 8);

  const flat = useMemo(() => {
    // Subsection numbers are user-editable, so duplicates are possible —
    // disambiguate to keep per-section state (and React keys) collision-free.
    const seen = new Set<string>();
    return outline.flatMap((ch, ci) =>
      ch.subsections.map((sub, si) => {
        let key = subKey(ch.chapter_number, sub.number);
        if (seen.has(key)) key = `${key}#${ci}.${si}`;
        seen.add(key);
        return { ch, sub, key };
      }),
    );
  }, [outline]);

  const resolvedIds = (sub: OutlineSubsection): string[] =>
    sub.source_ids ?? sub.likely_sources ?? [];

  const setSec = (key: string, patch: Partial<SecState>) =>
    setSecs((prev) => ({ ...prev, [key]: { ...(prev[key] ?? freshSec()), ...patch } }));

  // ---- history: bind / snapshot / restore / autosave -----------------------

  const applySnapshot = (snap: MakalahSnapshot) => {
    setTopic(snap.topic);
    setLanguage(snap.language);
    setAcademicLevel(snap.academicLevel);
    setSelected(snap.selected);
    setMode(snap.mode);
    setChaptersText(snap.chaptersText);
    setMinSubs(snap.minSubs);
    setMaxSubs(snap.maxSubs);
    setTargetWords(snap.targetWords);
    setCitationStyle(snap.citationStyle);
    setCover(snap.cover);
    setOutline(snap.outline);
    setCoverageNotes(snap.coverageNotes);
    setApproved(snap.approved);
    const rehydrated: Record<string, SecState> = {};
    for (const [k, s] of Object.entries(snap.secs ?? {})) {
      rehydrated[k] = {
        ...freshSec(),
        status: s.status === "ok" || s.status === "error" ? s.status : "idle",
        passages: s.passages ?? [],
        output: s.output ?? null,
        error: s.error ?? null,
        integrity: s.integrity ?? null,
        claims: s.claims ?? null,
      };
    }
    setSecs(rehydrated);
    setReferences(snap.references ?? []);
    setStep(Math.min(4, Math.max(1, snap.step || 1)));
    setOutlineError(null);
    setRunNote(null);
  };

  const resetWorkbench = () => applySnapshot(blankSnapshot());

  // bind to the active draft once the context hydrates
  useEffect(() => {
    if (!hydrated || docId) return;
    const target = drafts.find((d) => d.id === activeId) ?? drafts[0];
    if (!target) return;
    setDocId(target.id);
    applySnapshot(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // if the bound draft disappears (deleted in the panel), fall back
  useEffect(() => {
    if (!hydrated || !docId) return;
    if (drafts.some((d) => d.id === docId)) return;
    const fallback = drafts.find((d) => d.id === activeId) ?? drafts[0];
    if (!fallback) return;
    setDocId(fallback.id);
    applySnapshot(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, docId, drafts, activeId]);

  // autosave the working state into the bound draft (debounced)
  useEffect(() => {
    if (!hydrated || !docId) return;
    const persistedSecs: MakalahSnapshot["secs"] = {};
    for (const [k, s] of Object.entries(secs)) {
      persistedSecs[k] = {
        status: s.status, passages: s.passages, output: s.output,
        error: s.error, integrity: s.integrity, claims: s.claims,
      };
    }
    const snap: MakalahSnapshot = {
      topic, language, academicLevel, selected, mode, chaptersText,
      minSubs, maxSubs, targetWords, citationStyle, cover,
      outline, coverageNotes, approved, secs: persistedSecs, references, step,
    };
    const t = setTimeout(() => saveDraft(docId, snap), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, docId, topic, language, academicLevel, selected, mode, chaptersText, minSubs, maxSubs, targetWords, citationStyle, cover, outline, coverageNotes, approved, secs, references, step]);

  const openDraft = (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!d) return;
    selectDraft(id);
    setDocId(id);
    applySnapshot(d);
  };

  const handleNew = () => {
    const id = newDraft();
    if (!id) return;
    setDocId(id);
    resetWorkbench();
  };

  // ---- outline -----------------------------------------------------------

  const sanitizeOutline = (chs: OutlineChapter[]): OutlineChapter[] =>
    chs.map((ch) => ({
      ...ch,
      subsections: ch.subsections.map((s) => ({
        ...s,
        likely_sources: (s.likely_sources ?? []).filter((id) => selected.includes(id)),
        source_ids: s.source_ids ? s.source_ids.filter((id) => selected.includes(id)) : undefined,
      })),
    }));

  const buildModeBOutline = (): OutlineChapter[] => {
    const lines = chaptersText.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.map((line, ci) => {
      const { number, title } = parseChapterLine(line, ci);
      const subs: OutlineSubsection[] = [0, 1, 2].map((si) => ({
        number: `${ci + 1}.${si + 1}`,
        title: "",
        source_ids: [],
      }));
      return { chapter_number: number, chapter_title: title, subsections: subs };
    });
  };

  const runOutline = async () => {
    if (!topic.trim() || outlineLoading) return;
    if (!selected.length) { setOutlineError("Select at least one source document first."); return; }
    setOutlineLoading(true);
    setOutlineError(null);
    try {
      const summaries = await api.makalahSources(selected);
      const lines = chaptersText.split("\n").map((l) => l.trim()).filter(Boolean);
      const res = await api.makalahOutline({
        topic: topic.trim(),
        language,
        academic_level: academicLevel,
        source_summaries: summaries,
        template_constraints: {
          required_top_level_sections: lines.length ? lines : DEFAULT_CHAPTERS.split("\n"),
          min_subsections_per_chapter: minSubs,
          max_subsections_per_chapter: maxSubs,
        },
      });
      const clean = sanitizeOutline(res.outline);
      // approved shape uses source_ids
      setOutline(clean.map((ch) => ({
        ...ch,
        subsections: ch.subsections.map((s) => ({
          number: s.number, title: s.title, source_ids: s.likely_sources ?? [],
        })),
      })));
      setCoverageNotes(res.coverage_notes);
      setApproved(false);
    } catch (e) {
      setOutlineError(e instanceof Error ? e.message : "Outline generation failed");
    } finally {
      setOutlineLoading(false);
    }
  };

  const startModeB = () => {
    setOutline(buildModeBOutline());
    setCoverageNotes("");
    setApproved(false);
    setOutlineError(null);
    setStep(2);
  };

  // ---- outline editing ----------------------------------------------------

  const patchSub = (ci: number, si: number, patch: Partial<OutlineSubsection>) => {
    setOutline((prev) => prev.map((ch, i) =>
      i !== ci ? ch : {
        ...ch,
        subsections: ch.subsections.map((s, j) => (j !== si ? s : { ...s, ...patch })),
      }));
    setApproved(false);
  };
  const patchChapter = (ci: number, patch: Partial<OutlineChapter>) => {
    setOutline((prev) => prev.map((ch, i) => (i !== ci ? ch : { ...ch, ...patch })));
    setApproved(false);
  };
  const moveSub = (ci: number, si: number, dir: -1 | 1) => {
    setOutline((prev) => prev.map((ch, i) => {
      if (i !== ci) return ch;
      const arr = [...ch.subsections];
      const j = si + dir;
      if (j < 0 || j >= arr.length) return ch;
      [arr[si], arr[j]] = [arr[j], arr[si]];
      return { ...ch, subsections: arr };
    }));
    setApproved(false);
  };
  const addSub = (ci: number) => {
    setOutline((prev) => prev.map((ch, i) => {
      if (i !== ci || ch.subsections.length >= maxSubs) return ch;
      const n = `${ci + 1}.${ch.subsections.length + 1}`;
      return { ...ch, subsections: [...ch.subsections, { number: n, title: "", source_ids: [] }] };
    }));
    setApproved(false);
  };
  const delSub = (ci: number, si: number) => {
    setOutline((prev) => prev.map((ch, i) =>
      i !== ci ? ch : { ...ch, subsections: ch.subsections.filter((_, j) => j !== si) }));
    setApproved(false);
  };
  const toggleSubSource = (ci: number, si: number, id: string) => {
    const cur = resolvedIds(outline[ci].subsections[si]);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patchSub(ci, si, { source_ids: next, likely_sources: undefined });
  };

  // ---- section loop (deterministic; app code owns control flow) -----------

  const runOne = async (key: string, chTitle: string, sub: OutlineSubsection, chapNum: string): Promise<SectionOutput | null> => {
    void chapNum;
    const scope = resolvedIds(sub);
    setSec(key, { status: "retrieving", error: null, passages: [], output: null, integrity: null, claims: null });
    try {
      const query = `${sub.title} ${chTitle} ${topic}`.trim();
      const passages = await api.makalahRetrieve(
        query, scope.length ? scope : selected,
        undefined, 8, 4,
      );
      setSec(key, { status: "generating", passages });
      const output = await api.makalahSection({
        topic: topic.trim(),
        chapter_title: chTitle,
        subsection_number: sub.number,
        subsection_title: sub.title,
        language,
        citation_style: citationStyle,
        passages,
        target_length_words: targetWords,
      });
      setSec(key, {
        status: "ok",
        output,
        integrity: validateSectionCitations(output, passages),
      });
      return output;
    } catch (e) {
      setSec(key, { status: "error", error: e instanceof Error ? e.message : "Section failed" });
      return null;
    }
  };

  const collectCitedIds = (outputs: Record<string, SectionOutput | null>): string[] => {
    const ids = new Set<string>();
    for (const out of Object.values(outputs)) {
      out?.paragraphs.forEach((p) => p.citations.forEach((c) => {
        if (c.source_id) ids.add(c.source_id);
      }));
    }
    return [...ids];
  };

  const runAll = async () => {
    if (running || !flat.length) return;
    setRunning(true);
    stopRef.current = false;
    setRunNote(null);
    const outputs: Record<string, SectionOutput | null> = {};
    for (const item of flat) {
      if (stopRef.current) { setRunNote("Stopped — generated sections are kept."); break; }
      // eslint-disable-next-line no-await-in-loop
      outputs[item.key] = await runOne(item.key, item.ch.chapter_title, item.sub, item.ch.chapter_number);
    }
    setRunning(false);
    try {
      setReferences(await api.makalahReferences(collectCitedIds(outputs)));
    } catch {}
    setStep(4);
  };

  const refreshReferences = async () => {
    const outputs: Record<string, SectionOutput | null> = {};
    for (const item of flat) outputs[item.key] = secs[item.key]?.output ?? null;
    try {
      setReferences(await api.makalahReferences(collectCitedIds(outputs)));
    } catch {}
  };

  const citedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const k of Object.keys(secs)) {
      secs[k]?.output?.paragraphs.forEach((p) => p.citations.forEach((c) => {
        if (c.source_id) ids.add(c.source_id);
      }));
    }
    return [...ids];
  }, [secs]);

  const quality: QualityReport = useMemo(() => {
    let total = 0;
    let valid = 0;
    const unsupported: QualityReport["unsupported_claims"] = [];
    let done = 0;
    for (const item of flat) {
      const st = secs[item.key];
      if (st?.status === "ok" && st.output) {
        done += 1;
        if (st.output.gaps.includes(SECTION_SALVAGE_MARKER)) {
          unsupported.push({
            subsection: `${item.sub.number} ${item.sub.title}`,
            paragraph: -1,
            reason: "raw-text fallback (no valid JSON, no citations) — verify manually or regenerate",
          });
        }
        const v = st.integrity ?? validateSectionCitations(st.output, st.passages);
        total += v.total;
        valid += v.valid;
        if (v.badIds.length) {
          unsupported.push({
            subsection: `${item.sub.number} ${item.sub.title}`,
            paragraph: -1,
            reason: `Cited unknown source id(s): ${v.badIds.join(", ")}`,
          });
        }
        if (!st.output.paragraphs.length) {
          unsupported.push({
            subsection: `${item.sub.number} ${item.sub.title}`,
            paragraph: -1,
            reason: "Section generated no paragraphs",
          });
        }
      } else if (st?.status === "error") {
        unsupported.push({
          subsection: `${item.sub.number} ${item.sub.title}`,
          paragraph: -1,
          reason: st.error ?? "Generation failed",
        });
      }
    }
    const refIds = new Set(references.map((r) => r.id));
    return {
      structure_complete: flat.length > 0 && done === flat.length,
      citation_integrity_pct: total ? Math.round((valid / total) * 100) : 100,
      unsupported_claims: unsupported,
      missing_references: citedIds.filter((id) => !refIds.has(id)),
      unused_sources: selected.filter((id) => !citedIds.includes(id)),
    };
  }, [flat, secs, references, citedIds, selected]);

  const runClaimCheck = async (key: string) => {
    const st = secs[key];
    if (!st?.output || st.claimBusy) return;
    setSec(key, { claimBusy: true });
    try {
      const results: Array<{ verdict: string; reason: string }> = [];
      for (const para of st.output.paragraphs) {
        const cited = st.passages.filter((p) =>
          para.citations.some((c) => c.source_id === p.source_id));
        // eslint-disable-next-line no-await-in-loop
        const r = await api.makalahClaimCheck(para.text, cited);
        results.push({ verdict: r.verdict, reason: r.reason });
      }
      setSec(key, { claims: results });
    } catch {
      setSec(key, { claims: [{ verdict: "not_supported", reason: "Claim check call failed" }] });
    } finally {
      setSec(key, { claimBusy: false });
    }
  };

  // ---- export --------------------------------------------------------------

  const isID = language.toLowerCase().startsWith("id");
  const docTitle = cover.title.trim() || topic.trim() || "Makalah";

  const mainLabel = settings.provider === "ollama" ? `ollama:${settings.model}` : `${settings.cloudProvider}:${settings.cloudModel}`;
  const resolveStageLabel = (st: { provider: string; model: string; cloudProvider: string; cloudModel: string } | undefined) =>
    !st || st.provider === "inherit"
      ? mainLabel
      : st.provider === "ollama"
        ? `ollama:${st.model || settings.model}`
        : `${st.cloudProvider}:${st.cloudModel || settings.cloudModel}`;
  const outlineModelLabel = resolveStageLabel(settings.makalahOutlineStage as unknown as { provider: string; model: string; cloudProvider: string; cloudModel: string } | undefined);
  const sectionModelLabel = resolveStageLabel(settings.makalahSectionStage as unknown as { provider: string; model: string; cloudProvider: string; cloudModel: string } | undefined);

  const buildMarkdown = (): string => {
    const lines: string[] = [`# ${docTitle}`, ""];
    for (const ch of outline) {
      lines.push(`## ${ch.chapter_number} ${ch.chapter_title}`, "");
      for (const sub of ch.subsections) {
        const st = secs[subKey(ch.chapter_number, sub.number)];
        lines.push(`### ${sub.number} ${sub.title}`, "");
        if (st?.output) {
          for (const p of st.output.paragraphs) {
            const cites = p.citations.map((c) => `[${titleOf(c.source_id)}${c.page ? `, h. ${c.page}` : ""}]`).join(" ");
            lines.push(`${p.text}${cites ? ` ${cites}` : ""}`, "");
          }
          if (st.output.gaps) lines.push(`> Kesenjangan: ${st.output.gaps}`, "");
        } else {
          lines.push("_Belum dibuat._", "");
        }
      }
    }
    lines.push(`## ${isID ? "Daftar Pustaka" : "References"}`, "");
    references.forEach((r) => lines.push(`- ${r.formatted_apa7}`));
    return lines.join("\n");
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const exportPDF = () => {
    setExportNote(null);
    const w = window.open("", "_blank");
    if (!w) {
      setExportNote("Popup blocked — allow popups for this site, then press Export PDF again.");
      return;
    }
    const secHtml = outline.map((ch) => `
      <h2>${escapeHtml(ch.chapter_number)} ${escapeHtml(ch.chapter_title)}</h2>
      ${ch.subsections.map((sub) => {
        const st = secs[subKey(ch.chapter_number, sub.number)];
        const paras = st?.output?.paragraphs.map((p) => {
          const cites = p.citations.map((c) =>
            `<span class="cite">[${escapeHtml(titleOf(c.source_id))}${c.page ? `, h. ${c.page}` : ""}]</span>`).join(" ");
          return `<p>${escapeHtml(p.text)} ${cites}</p>`;
        }).join("") ?? "<p><em>Belum dibuat.</em></p>";
        const gap = st?.output?.gaps ? `<p class="gap">Catatan: ${escapeHtml(st.output.gaps)}</p>` : "";
        return `<h3>${escapeHtml(sub.number)} ${escapeHtml(sub.title)}</h3>${paras}${gap}`;
      }).join("")}`).join("");
    const toc = outline.map((ch) => `
      <div class="toc-ch">${escapeHtml(ch.chapter_number)} ${escapeHtml(ch.chapter_title)}</div>
      ${ch.subsections.map((s) => `<div class="toc-sub">${escapeHtml(s.number)} ${escapeHtml(s.title)}</div>`).join("")}`).join("");
    w.document.write(`<!DOCTYPE html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8">
      <title>${escapeHtml(docTitle)}</title>
      <style>
        body{font-family:Georgia,serif;max-width:68ch;margin:2rem auto;line-height:1.7;padding:0 1rem;color:#111}
        .cover{text-align:center;margin:6rem 0 4rem;page-break-after:always}
        .cover h1{font-size:1.6rem;margin-bottom:2rem;text-transform:uppercase}
        .cover p{margin:.3rem 0}
        h2{font-size:1.2rem;margin-top:2.2rem;text-transform:uppercase;border-bottom:1px solid #999;padding-bottom:.3rem}
        h3{font-size:1.05rem;margin-top:1.4rem}
        .cite{color:#444;font-size:.85em}
        .gap{background:#f5f5f5;border-left:3px solid #999;padding:.4rem .8rem;font-size:.9em}
        .toc-ch{font-weight:bold;margin-top:.6rem}
        .toc-sub{margin-left:1.2rem}
        ol.refs li{margin-bottom:.5rem}
        @media print{.cover{margin-top:0}}
      </style></head><body>
      <div class="cover"><h1>${escapeHtml(docTitle)}</h1>
        ${cover.author ? `<p>${escapeHtml(cover.author)}${cover.nim ? ` — ${escapeHtml(cover.nim)}` : ""}</p>` : ""}
        ${cover.course ? `<p>${escapeHtml(cover.course)}</p>` : ""}
        ${cover.lecturer ? `<p>${escapeHtml(cover.lecturer)}</p>` : ""}
      </div>
      <h2>${isID ? "Daftar Isi" : "Table of Contents"}</h2>${toc}
      ${secHtml}
      <h2>${isID ? "Daftar Pustaka" : "References"}</h2>
      <ol class="refs">${references.map((r) => `<li>${escapeHtml(r.formatted_apa7)}</li>`).join("")}</ol>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const stepPill = (n: number, label: string) => (
    <button
      key={n}
      onClick={() => { if (n < step || (n === 2 && outline.length) || (n === 3 && approved)) setStep(n); }}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap ${step === n ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#8e8e8e]"}`}
    >{n}. {label}</button>
  );

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black min-h-0 relative">
      <Topbar title="Makalah" subtitle="Deterministic drafting pipeline — outline, approve, draft per section, export PDF" />
      {historyOpen && (
        <div className="absolute inset-0 z-20 flex">
          <aside className="w-64 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] h-full flex flex-col shadow-2xl">
            <MakalahHistoryPanel onOpen={openDraft} onNew={handleNew} onNavigate={() => setHistoryOpen(false)} />
          </aside>
          <button className="flex-1 bg-black/60 backdrop-blur-[1px]" onClick={() => setHistoryOpen(false)} aria-label="close history" />
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
          <div className="flex gap-2 overflow-x-auto no-scrollbar items-center">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className={`h-9 w-9 grid place-items-center rounded-xl border text-[#ececec] shrink-0 ${historyOpen ? "bg-white text-black border-white" : "bg-[#212121] border-[#2f2f2f] hover:bg-[#2f2f2f]"}`}
              title="Makalah history"
            >☰</button>
            {[1, 2, 3, 4].map((n) => stepPill(n, ["Setup", "Outline", "Drafting", "Result"][n - 1]))}
            <span className="ml-auto text-[11px] text-[#5f5f5f] self-center shrink-0 hidden sm:block">
              {settings.provider === "ollama" ? `ollama:${settings.model}` : `${settings.cloudProvider}:${settings.cloudModel}`}
            </span>
          </div>

          {/* STEP 1 — setup */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
                <label className="block text-xs text-[#8e8e8e]">Topik / Topic</label>
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="cth. Kecerdasan Buatan dalam Penelitian Hukum" className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2.5 text-sm text-white outline-none" />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="block text-xs text-[#8e8e8e]">Language
                    <select value={language} onChange={(e) => setLanguage(e.target.value)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white">
                      <option value="id-ID">id-ID (Indonesia)</option>
                      <option value="en-US">en-US (English)</option>
                    </select>
                  </label>
                  <label className="block text-xs text-[#8e8e8e]">Academic level
                    <select value={academicLevel} onChange={(e) => setAcademicLevel(e.target.value)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white">
                      <option value="undergraduate">undergraduate</option>
                      <option value="graduate">graduate</option>
                      <option value="high_school">high_school</option>
                      <option value="general">general</option>
                    </select>
                  </label>
                  <label className="block text-xs text-[#8e8e8e]">Citation style
                    <input value={citationStyle} onChange={(e) => setCitationStyle(e.target.value)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-[#8e8e8e]">Target words / subsection
                    <input type="number" min={100} max={1000} value={targetWords} onChange={(e) => setTargetWords(Number(e.target.value) || 300)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                  </label>
                  <div className="flex items-end gap-2">
                    <button onClick={() => setMode("A")} className={`flex-1 rounded-xl border px-3 py-2 text-xs ${mode === "A" ? "bg-white text-black border-white font-medium" : "border-[#2f2f2f] bg-[#212121] text-white"}`}>Mode A — AI proposes outline</button>
                    <button onClick={() => setMode("B")} className={`flex-1 rounded-xl border px-3 py-2 text-xs ${mode === "B" ? "bg-white text-black border-white font-medium" : "border-[#2f2f2f] bg-[#212121] text-white"}`}>Mode B — I define structure</button>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
                <div className="flex items-center">
                  <span className="text-sm font-medium text-white">Sources ({selected.length}/{docs.length})</span>
                  <button onClick={() => setSelected(selected.length === docs.length ? [] : docs.map((d) => d.id))} className="ml-auto text-xs text-[#8e8e8e] hover:text-white">{selected.length === docs.length ? "Clear" : "Select all"}</button>
                </div>
                <div className="max-h-48 overflow-y-auto space-y-1.5">
                  {docs.map((d) => {
                    const on = selected.includes(d.id);
                    return (
                      <button key={d.id} onClick={() => setSelected(on ? selected.filter((x) => x !== d.id) : [...selected, d.id])} className={`w-full text-left rounded-xl border px-3 py-2 text-xs ${on ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>
                        {on ? "✓ " : ""}{d.original_filename} {d.title && d.title !== d.original_filename ? `— ${d.title.slice(0, 60)}` : ""}
                      </button>
                    );
                  })}
                  {!docs.length && <div className="text-xs text-[#5f5f5f]">No documents — upload and approve in Library first.</div>}
                </div>
              </div>

              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
                <span className="text-sm font-medium text-white">Template constraints</span>
                <label className="block text-xs text-[#8e8e8e]">Required chapters (one per line)
                  <textarea value={chaptersText} onChange={(e) => setChaptersText(e.target.value)} rows={3} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs text-[#8e8e8e]">Min subsections / chapter
                    <input type="number" min={1} max={10} value={minSubs} onChange={(e) => setMinSubs(Number(e.target.value) || 2)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                  </label>
                  <label className="block text-xs text-[#8e8e8e]">Max subsections / chapter
                    <input type="number" min={1} max={10} value={maxSubs} onChange={(e) => setMaxSubs(Number(e.target.value) || 5)} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                  </label>
                </div>
              </div>

              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
                <span className="text-sm font-medium text-white">Cover (optional, used in PDF)</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(["title", "author", "nim", "course", "lecturer"] as const).map((f) => (
                    <label key={f} className={`block text-xs text-[#8e8e8e] ${f === "title" ? "sm:col-span-2" : ""}`}>{f}
                      <input value={cover[f]} onChange={(e) => setCover({ ...cover, [f]: e.target.value })} placeholder={f === "title" ? topic || "Judul makalah" : ""} className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end flex-wrap gap-2 items-center">
                <span className="text-[11px] text-[#5f5f5f] mr-auto">
                  outline {outlineModelLabel} • sections {sectionModelLabel} — change in Settings → Makalah pipeline
                </span>
                {mode === "A" ? (
                  <button onClick={() => { setStep(2); if (!outline.length) runOutline(); }} disabled={!topic.trim() || !selected.length} className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40">Continue → outline</button>
                ) : (
                  <button onClick={startModeB} disabled={!topic.trim()} className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40">Continue → define structure</button>
                )}
              </div>
            </div>
          )}

          {/* STEP 2 — outline */}
          {step === 2 && (
            <div className="space-y-4">
              {mode === "A" && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={runOutline} disabled={outlineLoading} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40">{outlineLoading ? "Generating outline…" : outline.length ? "↻ Regenerate outline" : "Generate outline"}</button>
                  {outlineLoading && <span className="text-xs text-[#8e8e8e]">LLM call #1 — structure only, no content yet.</span>}
                </div>
              )}
              {outlineError && <div className="text-xs text-red-400 border border-red-900 bg-red-950/30 rounded-xl px-3 py-2">{outlineError}</div>}
              {coverageNotes && <div className="text-xs text-[#8e8e8e] border border-[#2f2f2f] bg-[#0a0a0a] rounded-xl px-3 py-2">Coverage notes: {coverageNotes}</div>}

              {outline.map((ch, ci) => (
                <div key={ci} className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
                  <div className="flex gap-2">
                    <input value={ch.chapter_number} onChange={(e) => patchChapter(ci, { chapter_number: e.target.value })} className="w-24 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                    <input value={ch.chapter_title} onChange={(e) => patchChapter(ci, { chapter_title: e.target.value })} className="flex-1 min-w-0 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                    <button onClick={() => { setOutline((p) => p.filter((_, i) => i !== ci)); setApproved(false); }} className="text-xs text-red-400 px-2" title="Delete chapter">✕</button>
                  </div>
                  {(ch.subsections.length < minSubs || ch.subsections.length > maxSubs) && (
                    <div className="text-[11px] text-amber-300">Constraint: {minSubs}–{maxSubs} subsections per chapter (now {ch.subsections.length}).</div>
                  )}
                  {ch.subsections.map((sub, si) => (
                    <div key={si} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 space-y-2">
                      <div className="flex gap-2">
                        <input value={sub.number} onChange={(e) => patchSub(ci, si, { number: e.target.value })} className="w-16 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white" />
                        <input value={sub.title} onChange={(e) => patchSub(ci, si, { title: e.target.value })} placeholder="Subsection title…" className="flex-1 min-w-0 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white" />
                        <button onClick={() => moveSub(ci, si, -1)} className="text-[#8e8e8e] hover:text-white text-xs px-1">↑</button>
                        <button onClick={() => moveSub(ci, si, 1)} className="text-[#8e8e8e] hover:text-white text-xs px-1">↓</button>
                        <button onClick={() => delSub(ci, si)} className="text-red-400 text-xs px-1">✕</button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selected.map((id) => {
                          const on = resolvedIds(sub).includes(id);
                          return (
                            <button key={id} onClick={() => toggleSubSource(ci, si, id)} title={titleOf(id)} className={`rounded-full px-2.5 py-1 text-[11px] border ${on ? "bg-white text-black border-white" : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e]"}`}>
                              {on ? "✓ " : ""}{titleOf(id).slice(0, 28)}
                            </button>
                          );
                        })}
                        {!resolvedIds(sub).length && <span className="text-[11px] text-[#5f5f5f]">no sources mapped — retrieval will search all selected docs</span>}
                      </div>
                    </div>
                  ))}
                  <button onClick={() => addSub(ci)} disabled={ch.subsections.length >= maxSubs} className="text-xs text-[#8e8e8e] hover:text-white disabled:opacity-40">+ Add subsection</button>
                </div>
              ))}

              <div className="flex gap-2 justify-between">
                <button onClick={() => setStep(1)} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2.5 text-sm text-white">← Setup</button>
                <button
                  onClick={() => { setApproved(true); setStep(3); }}
                  disabled={!outline.length || outline.some((ch) => ch.subsections.some((s) => !s.title.trim()))}
                  className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40"
                >Approve outline → drafting</button>
              </div>
            </div>
          )}

          {/* STEP 3 — drafting */}
          {step === 3 && (
            <div className="space-y-4">
              {!approved && <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">Outline was edited after approval — review it in step 2, then approve again before drafting.</div>}
              <div className="flex gap-2 flex-wrap">
                <button onClick={runAll} disabled={running || !approved} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40">{running ? "Drafting…" : "Generate all sections"}</button>
                {running && <button onClick={() => { stopRef.current = true; }} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">■ Stop (keep partial)</button>}
                <button onClick={() => setStep(4)} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">Preview →</button>
              </div>
              {runNote && <div className="text-xs text-[#8e8e8e]">{runNote}</div>}

              {flat.map((item) => {
                const st = secs[item.key] ?? freshSec();
                return (
                  <div key={item.key} className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white min-w-0 break-words flex-1 basis-40">{item.sub.number} {item.sub.title}</span>
                      <span className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border ${st.status === "ok" ? "text-emerald-400 border-emerald-900" : st.status === "error" ? "text-red-400 border-red-900" : st.status === "idle" ? "text-[#5f5f5f] border-[#2f2f2f]" : "text-amber-300 border-amber-800"}`}>
                        {st.status === "retrieving" ? "retrieving…" : st.status === "generating" ? "generating…" : st.status}
                      </span>
                      <button onClick={() => runOne(item.key, item.ch.chapter_title, item.sub, item.ch.chapter_number)} disabled={running} className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40">
                        {st.status === "ok" ? "↻ Regenerate" : "Generate"}
                      </button>
                    </div>
                    <div className="text-[11px] text-[#5f5f5f]">
                      {item.ch.chapter_number} {item.ch.chapter_title} • sources: {resolvedIds(item.sub).length ? resolvedIds(item.sub).map(titleOf).join(", ") : "all selected"}
                      {st.passages.length > 0 && ` • ${st.passages.length} passages`}
                      {st.integrity && ` • citations ${st.integrity.valid}/${st.integrity.total} valid`}
                    </div>
                    {st.error && <div className="text-xs text-red-400">{st.error}</div>}
                    {st.output?.gaps.includes(SECTION_SALVAGE_MARKER) && (
                      <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">⚠ Model didn&apos;t return JSON — raw text kept without citations. Press Regenerate (or switch to a stronger section model in Settings) and verify before keeping.</div>
                    )}
                    {st.integrity && st.integrity.badIds.length > 0 && (
                      <div className="text-xs text-red-400">Hallucinated source id(s) rejected by validator: {st.integrity.badIds.join(", ")}</div>
                    )}
                    {st.output && !st.editing && (
                      <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] px-4 py-3 text-sm leading-relaxed text-[#ececec] space-y-2">
                        {st.output.paragraphs.map((p, i) => (
                          <div key={i}>
                            <Markdown content={p.text} />
                            <div className="text-[11px] text-[#8e8e8e] mt-1">
                              {p.citations.map((c, j) => <span key={j} className="mr-2">[{titleOf(c.source_id)}{c.page ? `, h. ${c.page}` : ""}]</span>)}
                              {st.claims?.[i] && (
                                <span className={`ml-1 px-1.5 py-0.5 rounded-full border ${st.claims[i].verdict === "supported" ? "text-emerald-400 border-emerald-900" : "text-red-400 border-red-900"}`}>
                                  {st.claims[i].verdict === "supported" ? "✓ supported" : "✕ not supported"}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                        {st.output.gaps && <div className="text-xs text-amber-300 border-t border-[#2f2f2f] pt-2">Gap: {st.output.gaps}</div>}
                      </div>
                    )}
                    {st.output && st.editing && (
                      <div className="space-y-2">
                        <textarea value={st.editText} onChange={(e) => setSec(item.key, { editText: e.target.value })} rows={8} className="w-full rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setSec(item.key, { editing: false })} className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e]">Cancel</button>
                          <button
                            onClick={() => {
                              const parts = st.editText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
                              const origCites = st.output!.paragraphs.map((p) => p.citations);
                              setSec(item.key, {
                                editing: false,
                                output: {
                                  gaps: st.output!.gaps,
                                  paragraphs: parts.map((text, i) => ({ text, citations: origCites[i] ?? origCites[origCites.length - 1] ?? [] })),
                                },
                              });
                            }}
                            className="rounded-full bg-white text-black px-3 py-1 text-xs font-medium"
                          >Save</button>
                        </div>
                      </div>
                    )}
                    {st.output && (
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={() => setSec(item.key, { editing: !st.editing, editText: st.output!.paragraphs.map((p) => p.text).join("\n\n") })} className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717]">✎ {st.editing ? "Close editor" : "Edit text"}</button>
                        <button onClick={() => runClaimCheck(item.key)} disabled={st.claimBusy} className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40">
                          {st.claimBusy ? "Checking…" : "Run claim-support check"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* STEP 4 — result */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
                <div className="text-sm font-medium text-white">Quality report</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
                    <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Structure</div>
                    <div className={`text-sm font-semibold ${quality.structure_complete ? "text-emerald-400" : "text-amber-300"}`}>{quality.structure_complete ? "complete" : "incomplete"}</div>
                  </div>
                  <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
                    <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Citations</div>
                    <div className="text-sm font-semibold text-white">{quality.citation_integrity_pct}%</div>
                  </div>
                  <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
                    <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">Issues</div>
                    <div className="text-sm font-semibold text-white">{quality.unsupported_claims.length}</div>
                  </div>
                  <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] py-2 px-1">
                    <div className="text-[10px] text-[#8e8e8e] uppercase tracking-widest">References</div>
                    <div className="text-sm font-semibold text-white">{references.length}</div>
                  </div>
                </div>
                {quality.unsupported_claims.length > 0 && (
                  <div className="space-y-1">
                    {quality.unsupported_claims.map((u, i) => (
                      <div key={i} className="text-xs text-red-400">✕ {u.subsection}: {u.reason}</div>
                    ))}
                  </div>
                )}
                {quality.missing_references.length > 0 && (
                  <div className="text-xs text-amber-300">Missing metadata for: {quality.missing_references.join(", ")}</div>
                )}
                {quality.unused_sources.length > 0 && (
                  <div className="text-xs text-[#8e8e8e]">Selected but never cited: {quality.unused_sources.map(titleOf).join(", ")}</div>
                )}
                <div className="flex gap-2 flex-wrap pt-1">
                  <button onClick={exportPDF} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium">Export PDF (print)</button>                  <button onClick={copyMarkdown} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">{copied ? "✓ Copied" : "⧉ Copy Markdown"}</button>
                  <button onClick={refreshReferences} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">↻ Refresh references</button>
                  <button onClick={() => setStep(3)} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">← Back to drafting</button>
                </div>
                {exportNote && <div className="text-xs text-amber-300">{exportNote}</div>}
              </div>

              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-4">
                <h1 className="text-xl font-semibold text-white text-center">{docTitle}</h1>
                {(cover.author || cover.course) && (
                  <div className="text-center text-xs text-[#8e8e8e]">
                    {[cover.author && `${cover.author}${cover.nim ? ` — ${cover.nim}` : ""}`, cover.course, cover.lecturer].filter(Boolean).join(" • ")}
                  </div>
                )}
                {outline.map((ch, ci) => (
                  <div key={ci}>
                    <h2 className="text-base font-semibold text-white mt-2">{ch.chapter_number} {ch.chapter_title}</h2>
                    {ch.subsections.map((sub, si) => {
                      const st = secs[subKey(ch.chapter_number, sub.number)];
                      return (
                        <div key={si} className="mt-2">
                          <h3 className="text-sm font-medium text-[#ececec]">{sub.number} {sub.title}</h3>
                          {st?.output ? (
                            <div className="text-sm text-[#b4b4b4] leading-relaxed space-y-2 mt-1">
                              {st.output.paragraphs.map((p, i) => (
                                <div key={i}>
                                  <Markdown content={p.text} />
                                  <div className="text-[11px] text-[#5f5f5f]">{p.citations.map((c, j) => <span key={j} className="mr-2">[{titleOf(c.source_id)}{c.page ? `, h. ${c.page}` : ""}]</span>)}</div>
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
                  <h2 className="text-base font-semibold text-white mt-2">{isID ? "Daftar Pustaka" : "References"}</h2>
                  <ol className="list-decimal ml-5 text-sm text-[#b4b4b4] space-y-1 mt-1">
                    {references.map((r) => <li key={r.id}>{r.formatted_apa7}</li>)}
                    {!references.length && <li className="text-[#5f5f5f]">No cited sources yet.</li>}
                  </ol>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
