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
  stripLeakedCitations,
  stripTitleEchoes,
  isMalformedReference,
  findOutlineOverlaps,
  findRedundantPairs,
  sectionFullText,
  countAiFilled,
  refineOutline,
  makalahStageLabels,
  passageKey,
  buildNegativeList,
  SECTION_SALVAGE_MARKER,
  type OutlineChapter,
  type OutlineSubsection,
  type SectionOutput,
  type SectionPassage,
  type MakalahReference,
  type MakalahHybrid,
  type QualityReport,
} from "@/lib/wb/makalah";
import { sectionSimilarity } from "@/lib/text/similarity";
import { publishMakalah } from "@/lib/wb/publish";

const DEFAULT_CHAPTERS = "BAB I Pendahuluan\nBAB II Pembahasan\nBAB III Penutup";

type SecStatus = "idle" | "retrieving" | "generating" | "ok" | "error";
interface SecState {
  status: SecStatus;
  passages: SectionPassage[];
  output: SectionOutput | null;
  error: string | null;
  integrity: { total: number; valid: number; badIds: string[]; badPages: string[] } | null;
  claims: Array<{ verdict: string; reason: string }> | null;
  claimBusy: boolean;
  editing: boolean;
  editText: string;
}
const freshSec = (): SecState => ({
  status: "idle", passages: [], output: null, error: null,
  integrity: null, claims: null, claimBusy: false, editing: false, editText: "",
});

/** Bounded-concurrency mapper that preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const subKey = (chapter_number: string, number: string) => `${chapter_number}::${number}`;

function parseChapterLine(line: string, idx: number): { number: string; title: string } {
  const m = line.trim().match(/^(BAB\s+\S+)\s+([\s\S]*)$/i);
  if (m) return { number: m[1].toUpperCase(), title: (m[2] || line).trim() };
  return { number: `BAB ${idx + 1}`, title: line.trim() };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Walk section outputs and gather every cited source id (single helper for
 *  the memo, refresh, and post-run paths). */
function citedIdsOf(outputs: Array<SectionOutput | null>): string[] {
  const ids = new Set<string>();
  for (const out of outputs) {
    out?.paragraphs.forEach((p) => p.citations.forEach((c) => {
      if (c.source_id) ids.add(c.source_id);
    }));
  }
  return [...ids];
}

/** Merge fresh references over existing ones without touching entries the
 *  user hand-edited (`manual`) or that are already present. */
function mergeReferences(prev: MakalahReference[], fresh: MakalahReference[]): MakalahReference[] {
  const have = new Set(prev.map((r) => r.id));
  return [...prev, ...fresh.filter((f) => !have.has(f.id))];
}

/** Deterministic extractive summary: first sentence of each paragraph, capped. */
function summarizeOutput(output: SectionOutput, maxChars = 900): string {
  const bits: string[] = [];
  for (const p of output.paragraphs) {
    const first = p.text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    if (first) bits.push(first.slice(0, 300));
    if (bits.join("; ").length >= maxChars) break;
  }
  return bits.join("; ").slice(0, maxChars);
}

/**
 * COVERED prior context as labeled bullets (constraints, not prose — prose
 * summaries prime small models to echo the same sentences). Capped so the
 * context can't drown the section's own evidence. Number labels stay so the
 * model can still emit the sanctioned "As discussed in 1.1…" clause.
 */
function buildPrior(items: Array<{ label: string; summary: string }>, budget = 600): string {
  const lines: string[] = [];
  let len = 0;
  for (const a of items) {
    const line = `- [${a.label}]: ${a.summary}`;
    if (len + line.length > budget && lines.length) break;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join("\n");
}

/** Generic scope guard from outline fields (no topic knowledge). */
function scopeNoteOf(sub: OutlineSubsection): string {
  const parts: string[] = [];
  if (sub.focus?.trim()) parts.push(`focus: ${sub.focus.trim()}`);
  if (sub.must_not_cover?.length) parts.push(`do NOT cover: ${sub.must_not_cover.join("; ")}`);
  return parts.join(". ");
}

/** Cloud-quota failures need a different action than model bugs. */
function isQuotaError(msg: string): boolean {
  return /quota|429|rate.?limit|insufficient|exceed|credit|billing|resource_exhausted/i.test(msg);
}

interface MakalahDocItem {
  id: string;
  title: string | null;
  original_filename: string | null;
}

export default function MakalahPage() {
  const { settings } = useInference();
  const { drafts, activeId, hydrated, persistError, newDraft, selectDraft, saveDraft } = useMakalah();
  const [step, setStep] = useState(1);
  const [docs, setDocs] = useState<MakalahDocItem[]>([]);
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
  const [hybridMode, setHybridMode] = useState<MakalahHybrid>("15/85");
  const [cover, setCover] = useState({ title: "", author: "", nim: "", course: "", lecturer: "" });

  // outline
  const [outline, setOutline] = useState<OutlineChapter[]>([]);
  const [coverageNotes, setCoverageNotes] = useState("");
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [refineNote, setRefineNote] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  // drafting
  const [secs, setSecs] = useState<Record<string, SecState>>({});
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [autoRetryDup, setAutoRetryDup] = useState(false);
  const stopRef = useRef(false);
  // Mirror of secs for async callbacks (closures capture stale state mid-loop).
  const secsMirror = useRef<Record<string, SecState>>({});
  secsMirror.current = secs;
  // In-flight generation controller: Stop aborts the model call itself,
  // not just the loop between sections.
  const runSignal = useRef<AbortController | null>(null);
  useEffect(() => () => { runSignal.current?.abort(); }, []);

  // result
  const [references, setReferences] = useState<MakalahReference[]>([]);
  const [copied, setCopied] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [refEditText, setRefEditText] = useState("");

  useEffect(() => { api.listDocuments({}).then((r) => setDocs(r.documents)).catch(() => {}); }, []);

  const titleOf = (id: string) => {
    // Unmapped alias leaking into render (validator flags these) — never
    // show a raw "S2" as if it were a document title.
    if (/^S\d+$/i.test(id.trim())) return `Sumber ${id.trim().toUpperCase()} (tak terpetakan)`;
    return docs.find((d) => d.id === id)?.title ||
      docs.find((d) => d.id === id)?.original_filename ||
      id.slice(0, 8);
  };

  // id → display title for every known doc; sent to the engine so title-echo
  // leaks can be stripped precisely (generic: works for any topic/language).
  const allTitles = useMemo(
    () => Object.fromEntries(docs.map((d) => [d.id, d.title || d.original_filename || d.id])),
    [docs],
  );

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
    setHybridMode(snap.hybridMode === "off" || snap.hybridMode === "30/70" ? snap.hybridMode : "15/85");
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
    setRefineNote(null);
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
      minSubs, maxSubs, targetWords, citationStyle, hybridMode, cover,
      outline, coverageNotes, approved, secs: persistedSecs, references, step,
    };
    const t = setTimeout(() => saveDraft(docId, snap), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, docId, topic, language, academicLevel, selected, mode, chaptersText, minSubs, maxSubs, targetWords, citationStyle, hybridMode, cover, outline, coverageNotes, approved, secs, references, step]);

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

  /**
   * 🧹 Deduplicate + dead-end handling on the given outline (defaults to the
   * current one). Prunes drafted state detached by renumbering and resets
   * approval — run before drafting, never after.
   */
  const applyRefine = (base: OutlineChapter[] = outline): OutlineChapter[] => {
    const { outline: next, removed, redirected } = refineOutline(base, minSubs, selected);
    setOutline(next);
    const validKeys = new Set(
      next.flatMap((ch) => ch.subsections.map((s) => subKey(ch.chapter_number, s.number))),
    );
    setSecs((prev) => {
      const kept: Record<string, SecState> = {};
      for (const [k, v] of Object.entries(prev)) if (validKeys.has(k)) kept[k] = v;
      return kept;
    });
    setApproved(false);
    const bits: string[] = [];
    if (removed.length) bits.push(`dihapus: ${removed.join("; ")}`);
    if (redirected.length) bits.push(`dialihkan ke semua sumber: ${redirected.join("; ")}`);
    setRefineNote(bits.length ? `🧹 ${bits.join(" · ")}` : "🧹 Outline sudah bersih — tidak ada duplikat/dead-end.");
    return next;
  };

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
      // approved shape uses source_ids (keep focus/scope for drafting)
      const fresh = clean.map((ch) => ({
        ...ch,
        subsections: ch.subsections.map((s) => ({
          number: s.number, title: s.title, source_ids: s.likely_sources ?? [],
          ...(s.focus ? { focus: s.focus } : {}),
          ...(s.must_not_cover?.length ? { must_not_cover: s.must_not_cover } : {}),
        })),
      }));
      // auto-refine: dedup + dead-end handling straight after generation
      const { outline: refined, removed, redirected } = refineOutline(fresh, minSubs, selected);
      setOutline(refined);
      const validKeys = new Set(
        refined.flatMap((ch) => ch.subsections.map((s) => subKey(ch.chapter_number, s.number))),
      );
      setSecs((prev) => {
        const kept: Record<string, SecState> = {};
        for (const [k, v] of Object.entries(prev)) if (validKeys.has(k)) kept[k] = v;
        return kept;
      });
      const bits: string[] = [];
      if (removed.length) bits.push(`dihapus: ${removed.join("; ")}`);
      if (redirected.length) bits.push(`dialihkan ke semua sumber: ${redirected.join("; ")}`);
      setRefineNote(bits.length ? `🧹 ${bits.join(" · ")}` : null);
      setCoverageNotes(stripTitleEchoes(stripLeakedCitations(res.coverage_notes), selected.map(titleOf)));
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

  const runOne = async (
    key: string,
    chTitle: string,
    sub: OutlineSubsection,
    opts: {
      prior?: string;
      usedKeys?: Set<string>;
      collectPassages?: (psgs: SectionPassage[]) => void;
      signal?: AbortSignal;
      negativeList?: string;
      temperature?: number;
    } = {},
  ): Promise<SectionOutput | null> => {
    const scope = resolvedIds(sub);
    // Keep last-good output/passages while (re)generating: autosave persists
    // this state, so clearing first would destroy the previous draft on
    // reload/Stop (only the status overlay changes).
    const prevOut = secsMirror.current[key]?.output ?? null;
    setSec(key, { status: "retrieving", error: null, integrity: null, claims: null });
    try {
      // Focus-first query: the distinctive span is doubled so the embedding
      // centroid steers away from the chapter terms every sibling shares.
      // Without focus the query collapses to title+chapter+topic (Mode B) —
      // the Step-2 "tanpa fokus" hint nudges the human to fill it.
      const distinctive = `${sub.title} ${sub.focus ?? ""}`.replace(/\s+/g, " ").trim();
      const query = (sub.focus?.trim()
        ? `${distinctive} ${distinctive} ${chTitle} ${topic}`
        : `${distinctive} ${chTitle} ${topic}`
      ).replace(/\s+/g, " ").trim();
      // Evidence allocator: used keys go INTO retrieval (widen → exclude →
      // MMR → slice inside retrieveForSection). Post-slice reordering cannot
      // fix a truncated set, so nothing is sorted here. Single regenerations
      // default to excluding every other section's passages (fresh mirror).
      // Synthesis chapters skip the allocator entirely: their pool is the
      // already-cited passages of drafted sections (no new evidence, no
      // disjointness — forcing fresh evidence is what pushed 3.1 off-topic).
      let passages: SectionPassage[];
      if (isSynthesisKey(key)) {
        passages = synthesisPool(key);
        if (!passages.length) {
          passages = await api.makalahRetrieve(
            query, scope.length ? scope : selected,
            undefined, 8, 4,
          );
        }
      } else {
        const usedForCall = opts.usedKeys ?? new Set(
          Object.entries(secsMirror.current)
            .filter(([k]) => k !== key)
            .flatMap(([, s]) => s.passages.map(passageKey)),
        );
        const exclude = usedForCall.size ? [...usedForCall] : undefined;
        passages = await api.makalahRetrieve(
          query, scope.length ? scope : selected,
          undefined, 8, 4, exclude,
        );
      }
      // Fallback: subsection dapat 0 passage — lebarkan ke chapter+topik
      // di semua dokumen terpilih sebelum menyerah ke mode hybrid.
      if (!passages.length) {
        passages = await api.makalahRetrieve(
          `${chTitle} ${topic}`.trim(),
          selected.length ? selected : undefined,
          undefined, 8, 4,
        );
      }
      opts.collectPassages?.(passages);
      setSec(key, { status: "generating", passages });
      // Document context: outline position + what earlier sections already
      // said (deterministic summaries, no extra LLM calls) + scope guard.
      const fullOutline = outline
        .flatMap((ch) => ch.subsections.map((s) => `${s.number} ${s.title}`))
        .join(" | ");
      let prior = opts.prior;
      if (prior === undefined) {
        const idx = flat.findIndex((f) => f.key === key);
        const earlier = (idx >= 0 ? flat.slice(0, idx) : []).filter((f) => secs[f.key]?.output);
        prior = buildPrior(
          earlier.map((f) => ({
            label: `${f.sub.number} ${f.sub.title}`,
            summary: summarizeOutput(secs[f.key]!.output!),
          })),
        );
      }
      const output = await api.makalahSection({
        topic: topic.trim(),
        chapter_title: chTitle,
        subsection_number: sub.number,
        subsection_title: sub.title,
        language,
        citation_style: citationStyle,
        passages,
        target_length_words: targetWords,
        source_titles: allTitles,
        grounding: hybridMode,
        temperature: opts.temperature,
        outline_context: {
          full_outline: fullOutline,
          prior_summaries: prior ?? "",
          scope_note: scopeNoteOf(sub),
          negative_list: opts.negativeList,
          is_last_chapter: isLastChapterKey(key),
        },
      }, opts.signal);
      setSec(key, {
        status: "ok",
        output,
        integrity: validateSectionCitations(output, passages),
      });
      return output;
    } catch (e) {
      const aborted = opts.signal?.aborted ||
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && /abort/i.test(e.message));
      if (aborted) {
        // Stop pressed: restore last-good state, keep the text. The caller
        // counts the previous output (if any) instead of a failure.
        setSec(key, { status: prevOut ? "ok" : "idle", error: null });
        return prevOut;
      }
      const msg = e instanceof Error ? e.message : "Section failed";
      setSec(key, {
        status: "error",
        error: isQuotaError(msg)
          ? `${msg} — cloud quota/billing limit hit. Nothing is lost: switch the section stage to Ollama in Settings → Makalah pipeline (or wait for reset), then press Regenerate on this section.`
          : msg,
      });
      return null;
    }
  };

  const stopAll = () => {
    stopRef.current = true;
    runSignal.current?.abort();
    setRunNote("Dihentikan — hasil sejauh ini tersimpan, teks terakhir yang baik tidak dihapus.");
  };

  const runAll = async () => {
    if (running || !flat.length) return;
    if (!selected.length) {
      setRunNote("Pilih minimal 1 dokumen sumber di Step 1 dulu — tanpa sumber, retrieval berjalan tanpa batas dan sitasi menunjuk dokumen acak.");
      return;
    }
    setRunning(true);
    stopRef.current = false;
    runSignal.current = null;
    setRunNote(null);
    const outputs: Record<string, SectionOutput | null> = {};
    const acc: Array<{ label: string; summary: string; text: string; output: SectionOutput; isClosing: boolean }> = [];
    const used = new Set<string>();
    let retries = 0;
    for (const item of flat) {
      if (stopRef.current) { setRunNote("Stopped — generated sections are kept."); break; }
      const prior = buildPrior(acc);
      const ctrl = new AbortController();
      runSignal.current = ctrl;
      let lastCollected: string[] = [];
      const collect = (psgs: SectionPassage[]) => {
        lastCollected = psgs.map(passageKey);
        for (const k of lastCollected) used.add(k);
      };
      // eslint-disable-next-line no-await-in-loop
      let out = await runOne(item.key, item.ch.chapter_title, item.sub, {
        prior,
        usedKeys: used,
        collectPassages: collect,
        signal: ctrl.signal,
      });
      // P3 (opt-in): in-loop correction, not post-hoc report. One bounded
      // retry with changed inputs (fresh evidence + verbatim negative list).
      // Diversity comes from fresh evidence + negative list (temperature is
      // ignored by Gemini 3, so the old 0.3 bump was a no-op on cloud).
      if (out && autoRetryDup && !stopRef.current && !ctrl.signal.aborted) {
        const selfClosing = isLastChapterKey(item.key);
        const selfText = sectionFullText(out);
        let worst: { a: (typeof acc)[number]; s: number } | null = null;
        for (const a of acc) {
          const s = sectionSimilarity(selfText, a.text);
          if (!worst || s > worst.s) worst = { a, s: s };
        }
        const bar = selfClosing || (worst && worst.a.isClosing) ? 0.94 : 0.88;
        if (worst && worst.s >= bar) {
          for (const k of lastCollected) used.delete(k);
          // eslint-disable-next-line no-await-in-loop
          const out2 = await runOne(item.key, item.ch.chapter_title, item.sub, {
            prior,
            usedKeys: used,
            collectPassages: collect,
            signal: ctrl.signal,
            negativeList: buildNegativeList(worst.a.output),
          });
          retries += 1;
          if (out2) out = out2;
        }
      }
      outputs[item.key] = out;
      if (out) {
        acc.push({
          label: `${item.sub.number} ${item.sub.title}`,
          summary: summarizeOutput(out),
          text: sectionFullText(out),
          output: out,
          isClosing: isLastChapterKey(item.key),
        });
      }
    }
    runSignal.current = null;
    setRunning(false);
    try {
      const fresh = await api.makalahReferences(citedIdsOf(Object.values(outputs)));
      setReferences((prev) => mergeReferences(prev, fresh));
    } catch (e) {
      console.warn("makalah post-run references refresh failed", e);
    }
    const failed = flat.filter((item) => outputs[item.key] == null);
    if (!failed.length && !stopRef.current) {
      setStep(4);
    } else if (failed.length) {
      setRunNote(
        `Incomplete — ${failed.length} section(s) failed: ${failed.map((f) => `${f.sub.number} ${f.sub.title}`).join(", ")}. Fix quota/model, Regenerate them, then Preview.`,
      );
    }
    if (retries > 0) {
      setRunNote((prev) => `${prev ? `${prev} ` : ""}${retries}× auto-retry duplikasi dijalankan (evidence baru + daftar kalimat terlarang).`);
    }
  };

  const refreshReferences = async () => {
    try {
      const fresh = await api.makalahReferences(
        citedIdsOf(flat.map((item) => secs[item.key]?.output ?? null)),
      );
      setReferences((prev) => mergeReferences(prev, fresh));
      setExportNote(null);
    } catch (e) {
      setExportNote(`Refresh references gagal: ${e instanceof Error ? e.message : "unknown error"}. Periksa koneksi / login, lalu coba lagi.`);
    }
  };

  // References go stale when sections are (re)generated one by one instead of
  // via Generate-all — top up the missing ones before preview/export/copy so
  // Daftar Pustaka is never silently empty. Failures are RETURNED, never
  // swallowed: callers turn them into an export-blocking message.
  const ensureReferences = async (): Promise<{ refs: MakalahReference[]; error: string | null }> => {
    const missing = citedIdsOf(flat.map((item) => secs[item.key]?.output ?? null))
      .filter((id) => !references.some((r) => r.id === id));
    if (!missing.length) return { refs: references, error: null };
    try {
      const fresh = await api.makalahReferences(missing);
      const merged = [...references, ...fresh.filter((f) => !references.some((r) => r.id === f.id))];
      setReferences(merged);
      return { refs: merged, error: null };
    } catch (e) {
      return { refs: references, error: e instanceof Error ? e.message : "Refresh references gagal" };
    }
  };

  const outlineOverlaps = useMemo(() => findOutlineOverlaps(outline), [outline]);

  // Export gate: a paper with missing or salvaged sections must never ship
  // as PDF/Markdown. Preview (step 4) stays viewable — export is blocked.
  // `refs` override lets export check AFTER topping up references.
  //
  // Product decision (Priority 3): citation page mismatches (badPages)
  // default to warning-only and do NOT block export here (page misattribution
  // is a softer defect than a fabricated source id or missing section).
  // Surfaced in the quality report for author review.
  const exportBlockers = (refs: MakalahReference[] = references): string[] => {
    const missing = flat.filter(
      (item) => secs[item.key]?.status !== "ok" || !secs[item.key]?.output);
    const salvage = flat.filter(
      (item) => secs[item.key]?.output?.gaps.includes(SECTION_SALVAGE_MARKER));
    const errs: string[] = [];
    if (missing.length) {
      errs.push(`Belum lengkap: ${missing.map((f) => `${f.sub.number} ${f.sub.title}`).join(", ")} — Generate/Regenerate dulu.`);
    }
    if (salvage.length) {
      errs.push(`Tanpa sitasi (gagal JSON): ${salvage.map((f) => `${f.sub.number} ${f.sub.title}`).join(", ")} — Regenerate atau Edit manual dulu.`);
    }
    const citedNow = citedIdsOf(flat.map((item) => secs[item.key]?.output ?? null));
    const missingRefs = citedNow.filter((id) => !refs.some((r) => r.id === id));
    if (missingRefs.length) {
      errs.push(`Daftar Pustaka belum lengkap (${missingRefs.length} sumber: ${missingRefs.map((id) => titleOf(id)).join(", ")}) — metadata gagal dimuat, periksa koneksi lalu tekan Refresh references.`);
    }
    return errs;
  };

  const citedIds = useMemo(
    () => citedIdsOf(Object.values(secs).map((s) => s.output)),
    [secs],
  );

  const quality: QualityReport = useMemo(() => {
    let total = 0;
    let valid = 0;
    let aiFilled = 0;
    const unsupported: QualityReport["unsupported_claims"] = [];
    const pageMismatches: string[] = [];
    const missingPages: string[] = [];
    // Hallucinated alias ids (S2, S5…) are reported as ✕ unknown below and
    // must NOT also pollute "missing metadata" (they can never resolve to
    // a bibliography entry).
    const badIdSet = new Set<string>();
    let done = 0;
    for (const item of flat) {
      const st = secs[item.key];
      if (st?.status === "ok" && st.output) {
        done += 1;
        aiFilled += countAiFilled(st.output);
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
          v.badIds.forEach((id) => badIdSet.add(id));
          unsupported.push({
            subsection: `${item.sub.number} ${item.sub.title}`,
            paragraph: -1,
            reason: `Cited unknown source id(s): ${v.badIds.join(", ")}`,
          });
        }
        if (v.badPages?.length) {
          pageMismatches.push(
            `${item.sub.number} ${item.sub.title}: ${v.badPages.join(", ")}`,
          );
        }
        // Soft signal (not an error): citations that drop the page number on
        // a page-verifiable source. Without this, omitting pages is an easy
        // way to dodge the mismatch flag above.
        {
          const verifiable = new Set(
            st.passages.filter((p) => p.page != null).map((p) => p.source_id),
          );
          const noPage = new Map<string, number>();
          for (const para of st.output.paragraphs) {
            for (const c of para.citations) {
              if (c.page == null && c.source_id && verifiable.has(c.source_id)) {
                noPage.set(c.source_id, (noPage.get(c.source_id) ?? 0) + 1);
              }
            }
          }
          for (const [src, n] of noPage) {
            missingPages.push(`${item.sub.number} ${item.sub.title}: ${titleOf(src)} (${n} tanpa halaman)`);
          }
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
    const lastCh = outline.length > 1 ? outline[outline.length - 1] : null;
    const redundant_pairs = findRedundantPairs(
      flat
        .filter((item) => secs[item.key]?.output)
        .map((item) => ({
          label: `${item.sub.number} ${item.sub.title}`,
          text: sectionFullText(secs[item.key]!.output!),
          isClosing: !!lastCh && item.ch === lastCh,
        })),
    );
    return {
      structure_complete: flat.length > 0 && done === flat.length,
      citation_integrity_pct: total ? Math.round((valid / total) * 100) : 100,
      citation_total: total,
      unsupported_claims: unsupported,
      missing_references: citedIds.filter((id) => !refIds.has(id) && !badIdSet.has(id)),
      unused_sources: selected.filter((id) => !citedIds.includes(id)),
      malformed_references: references.filter((r) => isMalformedReference(r.formatted_apa7)).map((r) => r.id),
      redundant_pairs,
      ai_filled: aiFilled,
      citation_page_mismatches: pageMismatches,
      citation_missing_pages: missingPages,
    };
  }, [flat, secs, references, citedIds, selected]);

  const runClaimCheck = async (key: string) => {
    const st = secs[key];
    if (!st?.output || st.claimBusy) return;
    setSec(key, { claimBusy: true });
    try {
      const results = await mapWithConcurrency(
        st.output.paragraphs,
        3,
        async (para) => {
          // Match the exact cited evidence (source + page), not the whole
          // document: sending every chunk of a cited doc as "support" makes
          // the classifier rubber-stamp unrelated paragraphs as supported.
          const cited = st.passages.filter((p) =>
            para.citations.some((c) =>
              c.source_id === p.source_id &&
              (c.page == null || p.page == null || c.page === p.page)));
          const r = await api.makalahClaimCheck(para.text, cited);
          return { verdict: r.verdict, reason: r.reason };
        },
      );
      setSec(key, { claims: results });
    } catch {
      setSec(key, { claims: [{ verdict: "not_supported", reason: "Claim check call failed" }] });
    } finally {
      setSec(key, { claimBusy: false });
    }
  };

  /**
   * "Bukti baru": regenerate that provably diverges at temperature 0 by
   * changing inputs instead of sampling — excludes every passage this and
   * all other sections have used (forces fresh evidence via the allocator's
   * widen→exclude→MMR path) and injects the verbatim negative list of the
   * most-similar already-drafted section. Pool exhaustion (everything comes
   * back excluded) surfaces as a run note instead of silently cycling.
   */
  const regenFresh = async (key: string, chTitle: string, sub: OutlineSubsection) => {
    const mirror = secsMirror.current;
    const others = flat.filter((f) => f.key !== key && mirror[f.key]?.output);
    const used = new Set<string>();
    for (const f of others) for (const p of mirror[f.key]!.passages) used.add(passageKey(p));
    const own = mirror[key]?.passages ?? [];
    for (const p of own) used.add(passageKey(p));
    let negativeList: string | undefined;
    const selfText = sectionFullText(mirror[key]?.output);
    if (selfText.trim() && others.length) {
      let bestS = 0.5;
      let bestOut: SectionOutput | null = null;
      for (const f of others) {
        const t = sectionFullText(mirror[f.key]!.output!);
        const s = sectionSimilarity(selfText, t);
        if (s > bestS) { bestS = s; bestOut = mirror[f.key]!.output!; }
      }
      if (bestOut) negativeList = buildNegativeList(bestOut);
    }
    let collected: SectionPassage[] = [];
    // Synthesis sections reuse the fixed cited pool by design, so evidence
    // cannot diverge — variance comes from mild sampling on Ollama and from
    // the verbatim negative list on cloud (Gemini 3 ignores temperature).
    const synth = isSynthesisKey(key);
    const out = await runOne(key, chTitle, sub, {
      usedKeys: used,
      collectPassages: (psgs) => { collected = psgs; },
      negativeList,
      temperature: synth ? 0.3 : undefined,
    });
    if (out && !synth && collected.length && used.size >= 4) {
      const reused = collected.filter((p) => used.has(passageKey(p))).length;
      if (reused === collected.length) {
        setRunNote(
          `Pool bukti untuk ${sub.number} ${sub.title} habis — hasil memakai ulang evidence lama. Pertajam Fokus atau tambah sumber.`,
        );
      }
    }
  };

  // ---- export --------------------------------------------------------------

  const isID = language.toLowerCase().startsWith("id");
  const docTitle = cover.title.trim() || topic.trim() || "Makalah";

  /** True when the flat item belongs to the last outline chapter (Penutup). */
  const isLastChapterKey = (key: string): boolean => {
    const item = flat.find((f) => f.key === key);
    // Single-chapter outlines have no "closing" role to play.
    return !!item && outline.length > 1 && item.ch === outline[outline.length - 1];
  };

  /**
   * Role-aware evidence policy. Synthesis chapters (explicit flag, else last
   * position) must synthesize already-written sections — disjointness is
   * wrong for them: forcing fresh evidence pushes 3.1 off-topic instead of
   * de-duplicating it.
   */
  const isSynthesisKey = (key: string): boolean => {
    const item = flat.find((f) => f.key === key);
    if (!item || outline.length <= 1) return false;
    return item.ch.synthesis_only ?? item.ch === outline[outline.length - 1];
  };

  /**
   * Synthesis evidence pool: passages already CITED by drafted sections
   * (matched by source+page, deduped, capped). No retrieval call, no new
   * evidence — Penutup can only recombine what exists. Diversity first: one
   * representative passage per drafted section (flat order), so minor
   * sections cannot be silently dropped; remaining slots go to the
   * most-cited passages.
   */
  const synthesisPool = (excludeKey?: string): SectionPassage[] => {
    const cited = new Map<string, { p: SectionPassage; n: number; order: number; sec: number }>();
    let order = 0;
    flat.forEach((item, si) => {
      if (excludeKey && item.key === excludeKey) return;
      const st = secsMirror.current[item.key];
      if (st?.status !== "ok" || !st.output) return;
      const wanted = new Set<string>();
      for (const para of st.output.paragraphs) {
        for (const c of para.citations) {
          if (c.source_id) wanted.add(`${c.source_id}::${c.page ?? "?"}`);
        }
      }
      for (const p of st.passages) {
        if (!wanted.has(`${p.source_id}::${p.page ?? "?"}`)) continue;
        const k = passageKey(p);
        const e = cited.get(k);
        if (e) e.n += 1;
        else cited.set(k, { p, n: 1, order: order++, sec: si });
      }
    });
    const vals = [...cited.values()];
    const picked: typeof vals = [];
    const seenSec = new Set<number>();
    for (const v of vals) {
      if (!seenSec.has(v.sec)) {
        seenSec.add(v.sec);
        picked.push(v);
      }
    }
    const ranked = [...vals].sort((a, b) => b.n - a.n || a.order - b.order);
    for (const v of ranked) {
      if (picked.length >= 8) break;
      if (!picked.includes(v)) picked.push(v);
    }
    return picked.slice(0, 8).map((e) => e.p);
  };

  /**
   * P7 — evidence-overlap leading indicator. Compares stored passages against
   * every other section: predicts duplication before reading any text and
   * separates "retrieval caused this" from "model caused this".
   */
  const overlapNote = (key: string): { text: string; hot: boolean } | null => {
    // Synthesis chapters share evidence by design — never an alarm.
    if (isSynthesisKey(key)) {
      const n = secs[key]?.passages.length ?? 0;
      return n ? { text: "sintesis — memakai evidence section sebelumnya", hot: false } : null;
    }
    const own = secs[key]?.passages ?? [];
    if (!own.length) return null;
    const ownKeys = new Set(own.map(passageKey));
    const parts: string[] = [];
    let hot = false;
    for (const item of flat) {
      if (item.key === key) continue;
      const op = secs[item.key]?.passages ?? [];
      if (!op.length) continue;
      const shared = op.filter((p) => ownKeys.has(passageKey(p))).length;
      if (shared > 0) {
        if (shared / own.length > 0.5) hot = true;
        parts.push(`${shared}/${own.length} shared dengan ${item.sub.number}`);
      }
    }
    return parts.length ? { text: parts.join(" · "), hot } : null;
  };

  // Chapter-grouped flat items: every renderer (Markdown, PDF, preview)
  // looks sections up by collision-free item.key — never by raw
  // chapter+number, which duplicates and breaks the export gate contract.
  const flatByChapter = useMemo(() => {
    const groups: Array<{ ch: OutlineChapter; items: typeof flat }> = [];
    for (const item of flat) {
      const g = groups.find((x) => x.ch === item.ch);
      if (g) g.items.push(item);
      else groups.push({ ch: item.ch, items: [item] });
    }
    return groups;
  }, [flat]);

  const { outline: outlineModelLabel, section: sectionModelLabel } = makalahStageLabels(settings);

  const buildMarkdown = (refs: MakalahReference[] = references): string => {
    const lines: string[] = [`# ${docTitle}`, ""];
    for (const g of flatByChapter) {
      lines.push(`## ${g.ch.chapter_number} ${g.ch.chapter_title}`, "");
      for (const item of g.items) {
        const st = secs[item.key];
        lines.push(`### ${item.sub.number} ${item.sub.title}`, "");
        if (st?.output) {
          for (const p of st.output.paragraphs) {
            const cites = p.citations.map((c) => `[${titleOf(c.source_id)}${c.page ? `, h. ${c.page}` : ""}]`).join(" ");
            lines.push(`${p.text}${cites ? ` ${cites}` : ""}`, "");
          }
          // gaps intentionally excluded: drafting-view QA, never published
        } else {
          lines.push("_Belum dibuat._", "");
        }
      }
    }
    lines.push(`## ${isID ? "Daftar Pustaka" : "References"}`, "");
    refs.forEach((r) => lines.push(`- ${r.formatted_apa7}`));
    return lines.join("\n");
  };

  const copyMarkdown = async () => {
    const { refs, error } = await ensureReferences();
    if (error) {
      setExportNote(`Tidak bisa copy — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`);
      return;
    }
    const blockers = exportBlockers(refs);
    if (blockers.length) {
      setExportNote(`Tidak bisa copy — ${blockers.join(" ")}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMarkdown(refs));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const publishToShared = async () => {
    if (publishing) return;
    setExportNote(null);
    setPublishing(true);
    try {
      const { refs, error } = await ensureReferences();
      if (error) {
        setExportNote(`Tidak bisa publish — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`);
        return;
      }
      const blockers = exportBlockers(refs);
      if (blockers.length) {
        setExportNote(`Tidak bisa publish — ${blockers.join(" ")}`);
        return;
      }
      await publishMakalah({ title: docTitle, markdown: buildMarkdown(refs), topic: topic.trim(), language });
      setExportNote("Published to shared chats ✓ — visible in Research → Shared and /chats.");
    } catch (e) {
      setExportNote(`Publish gagal: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setPublishing(false);
    }
  };

  const exportPDF = async () => {
    setExportNote(null);
    const { refs, error } = await ensureReferences();
    if (error) {
      setExportNote(`Tidak bisa export — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`);
      return;
    }
    const blockers = exportBlockers(refs);
    if (blockers.length) {
      setExportNote(`Tidak bisa export — ${blockers.join(" ")}`);
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      setExportNote("Popup blocked — allow popups for this site, then press Export PDF again.");
      return;
    }
    const secHtml = flatByChapter.map(({ ch, items }) => `
      <h2>${escapeHtml(ch.chapter_number)} ${escapeHtml(ch.chapter_title)}</h2>
      ${items.map((item) => {
        const st = secs[item.key];
        const paras = st?.output?.paragraphs.map((p) => {
          const cites = p.citations.map((c) =>
            `<span class="cite">[${escapeHtml(titleOf(c.source_id))}${c.page ? `, h. ${c.page}` : ""}]</span>`).join(" ");
          return `<p>${escapeHtml(p.text)} ${cites}</p>`;
        }).join("") ?? "<p><em>Belum dibuat.</em></p>";
        // gaps intentionally excluded: drafting-view QA, never published
        return `<h3>${escapeHtml(item.sub.number)} ${escapeHtml(item.sub.title)}</h3>${paras}`;
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
      <ol class="refs">${refs.map((r) => `<li>${escapeHtml(r.formatted_apa7)}</li>`).join("")}</ol>
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
          {persistError && (
            <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">⚠ {persistError}</div>
          )}
          <div className="flex gap-2 overflow-x-auto no-scrollbar items-center">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className={`h-9 w-9 grid place-items-center rounded-xl border text-[#ececec] shrink-0 ${historyOpen ? "bg-white text-black border-white" : "bg-[#212121] border-[#2f2f2f] hover:bg-[#2f2f2f]"}`}
              title="Makalah history"
              aria-label="Makalah history"
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
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-white">Grounding</span>
                  {(["off", "15/85", "30/70"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setHybridMode(m)}
                      title={m === "off" ? "100% strict — setiap klaim faktual wajib dari passages" : m === "15/85" ? "85% sumber + 15% kecerdasan model untuk transisi/koherensi (disarankan)" : "70% sumber + 30% kecerdasan model untuk sintesis/kerangka teori"}
                      className={`rounded-full px-3 py-1.5 text-xs border ${hybridMode === m ? "bg-white text-black border-white font-medium" : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e] hover:text-white"}`}
                    >
                      {m === "off" ? "Strict" : m}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-[#5f5f5f]">
                  Strict = 100% sitasi sumber. 15/85 = +transisi narasi (disarankan). 30/70 = +sintesis teori. Paragraf tanpa sitasi selalu ditandai sebagai model-bridged di quality report — tidak pernah diklaim bersumber.
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
                  outline {outlineModelLabel} • sections {sectionModelLabel}
                  {settings.makalahThinking ? ` • thinking ${settings.makalahThinkLevel ?? "low"} · ${settings.makalahThinkingBudget ?? 1024} tok (drafting only)` : " • thinking off"}
                  {" "}— change in Settings → Makalah pipeline
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
                  {outline.length > 0 && !outlineLoading && (
                    <button onClick={() => applyRefine()} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white hover:bg-[#2f2f2f]" title="Hapus duplikat nomor/judul & dead-end tanpa sumber, lalu renumber. Jalankan sebelum drafting.">🧹 Bersihkan Outline</button>
                  )}
                  {outlineLoading && <span className="text-xs text-[#8e8e8e]">LLM call #1 — structure only, no content yet.</span>}
                </div>
              )}
              {mode === "B" && outline.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => applyRefine()} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white hover:bg-[#2f2f2f]" title="Hapus duplikat nomor/judul & dead-end tanpa sumber, lalu renumber. Jalankan sebelum drafting.">🧹 Bersihkan Outline</button>
                </div>
              )}
              {outlineError && <div className="text-xs text-red-400 border border-red-900 bg-red-950/30 rounded-xl px-3 py-2">{outlineError}</div>}
              {refineNote && <div className="text-xs text-[#8e8e8e] border border-[#2f2f2f] bg-[#0a0a0a] rounded-xl px-3 py-2">{refineNote}</div>}
              {coverageNotes && <div className="text-xs text-[#8e8e8e] border border-[#2f2f2f] bg-[#0a0a0a] rounded-xl px-3 py-2">Coverage notes: {coverageNotes}</div>}
              {outlineOverlaps.length > 0 && (
                <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">
                  Kemungkinan tumpang tindih outline: {outlineOverlaps.slice(0, 3).map((o) => `${o.a} ≈ ${o.b} (${o.score})`).join(" · ")}
                  {outlineOverlaps.length > 3 && ` (+${outlineOverlaps.length - 3} lainnya)`} — pertajam Fokus di bawah atau gabung sebelum drafting.
                </div>
              )}

              {outline.map((ch, ci) => (
                <div key={ci} className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
                  <div className="flex gap-2 items-center">
                    <input value={ch.chapter_number} onChange={(e) => patchChapter(ci, { chapter_number: e.target.value })} className="w-24 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                    <input value={ch.chapter_title} onChange={(e) => patchChapter(ci, { chapter_title: e.target.value })} className="flex-1 min-w-0 rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                    {(ch.synthesis_only ?? (outline.length > 1 && ci === outline.length - 1)) && (
                      <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-emerald-900 text-emerald-400" title="Bab sintesis: memakai ulang evidence yang sudah disitasi, tanpa bukti baru.">sintesis</span>
                    )}
                    <button onClick={() => { setOutline((p) => p.filter((_, i) => i !== ci)); setApproved(false); }} className="text-xs text-red-400 px-2" title="Delete chapter" aria-label="Delete chapter">✕</button>
                  </div>
                  {(ch.subsections.length < minSubs || ch.subsections.length > maxSubs) && (
                    <div className="text-[11px] text-amber-300">Constraint: {minSubs}–{maxSubs} subsections per chapter (now {ch.subsections.length}).</div>
                  )}
                  {ch.subsections.map((sub, si) => (
                    <div key={si} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 space-y-2">
                      <div className="flex gap-2">
                        <input value={sub.number} onChange={(e) => patchSub(ci, si, { number: e.target.value })} className="w-16 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white" />
                        <input value={sub.title} onChange={(e) => patchSub(ci, si, { title: e.target.value })} placeholder="Subsection title…" className="flex-1 min-w-0 rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white" />
                        <button onClick={() => moveSub(ci, si, -1)} aria-label="Move subsection up" className="text-[#8e8e8e] hover:text-white text-xs px-1">↑</button>
                        <button onClick={() => moveSub(ci, si, 1)} aria-label="Move subsection down" className="text-[#8e8e8e] hover:text-white text-xs px-1">↓</button>
                        <button onClick={() => delSub(ci, si)} aria-label="Delete subsection" className="text-red-400 text-xs px-1">✕</button>
                      </div>
                      <input
                        value={sub.focus ?? ""}
                        onChange={(e) => patchSub(ci, si, { focus: e.target.value })}
                        placeholder="Fokus — 1 kalimat: pertanyaan apa yang dijawab subbab ini? (dipakai untuk retrieval + anti-duplikasi)"
                        className="w-full rounded-lg bg-[#212121] border border-[#2f2f2f] px-2 py-1.5 text-xs text-white placeholder:text-[#5f5f5f]"
                      />
                      {!sub.focus?.trim() && (
                        <div className="text-[11px] text-amber-300/80">tanpa fokus — retrieval sulit dibedakan dari subbab lain; isi 1 kalimat.</div>
                      )}
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
                <label className="flex items-center gap-1.5 rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-xs text-[#ececec]" title="Saat Generate-all: tiap section yang terdeteksi duplikat (>0.88, Penutup >0.94) otomatis di-retry SEKALI dengan evidence baru + daftar kalimat terlarang. Untuk batch tanpa pengawasan.">
                  <input type="checkbox" checked={autoRetryDup} onChange={(e) => setAutoRetryDup(e.target.checked)} disabled={running} className="accent-white" />
                  Auto-retry duplikat 1×
                </label>
                <select
                  value={hybridMode}
                  onChange={(e) => setHybridMode(e.target.value as MakalahHybrid)}
                  disabled={running}
                  className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-xs text-white outline-none disabled:opacity-40"
                  title="Grounding mode untuk drafting"
                >
                  <option value="off" className="bg-[#171717]">Strict (100% sumber)</option>
                  <option value="15/85" className="bg-[#171717]">15/85 transisi</option>
                  <option value="30/70" className="bg-[#171717]">30/70 sintesis</option>
                </select>
                {running && <button onClick={stopAll} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">■ Stop (keep partial)</button>}
                <button onClick={async () => { const r = await ensureReferences(); if (r.error) setExportNote(`Daftar Pustaka gagal dimuat: ${r.error}. Tekan Refresh references.`); setStep(4); }} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">Preview →</button>
              </div>
              {runNote && <div className="text-xs text-[#8e8e8e]">{runNote}</div>}

              {flat.map((item) => {
                const st = secs[item.key] ?? freshSec();
                return (
                  <div key={item.key} className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white min-w-0 wrap-break-word flex-1 basis-40">{item.sub.number} {item.sub.title}</span>
                      <span className={`ml-auto text-[11px] px-2 py-0.5 rounded-full border ${st.status === "ok" ? "text-emerald-400 border-emerald-900" : st.status === "error" ? "text-red-400 border-red-900" : st.status === "idle" ? "text-[#5f5f5f] border-[#2f2f2f]" : "text-amber-300 border-amber-800"}`}>
                        {st.status === "retrieving" ? "retrieving…" : st.status === "generating" ? "generating…" : st.status}
                      </span>
                      <button onClick={() => runOne(item.key, item.ch.chapter_title, item.sub)} disabled={running || st.status === "retrieving" || st.status === "generating" || !selected.length} title={!selected.length ? "Pilih minimal 1 sumber di Step 1" : undefined} className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40">
                        {st.status === "ok" ? "↻ Regenerate" : "Generate"}
                      </button>
                      {st.status === "ok" && (
                        <button
                          onClick={() => regenFresh(item.key, item.ch.chapter_title, item.sub)}
                          disabled={running}
                          title="Regenerate dengan evidence yang belum dipakai section lain + daftar kalimat terlarang dari section paling mirip. Deterministik (suhu tetap 0; bab sintesis memakai ulang evidence + suhu 0.3)."
                          className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40"
                        >↻ Bukti baru</button>
                      )}
                    </div>
                    <div className="text-[11px] text-[#5f5f5f]">
                      {item.ch.chapter_number} {item.ch.chapter_title} • sources: {resolvedIds(item.sub).length ? resolvedIds(item.sub).map(titleOf).join(", ") : (selected.length ? "all selected" : "⚠ no sources selected — pilih di Step 1")}
                      {st.passages.length > 0 && ` • ${st.passages.length} passages`}
                      {st.integrity && ` • citations ${st.integrity.valid}/${st.integrity.total} valid`}
                      {st.integrity && st.integrity.badPages?.length > 0 && (
                        <span className="text-amber-300"> • {st.integrity.badPages.length} page mismatch</span>
                      )}
                      {(() => {
                        const ov = overlapNote(item.key);
                        return ov ? (
                          <span className={ov.hot ? "text-amber-300" : ""}> • 🧬 {ov.text}</span>
                        ) : null;
                      })()}
                    </div>
                    {st.error && <div className="text-xs text-red-400">{st.error}</div>}
                    {st.output?.gaps.includes(SECTION_SALVAGE_MARKER) && (
                      <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">⚠ Model didn&apos;t return JSON — raw text kept without citations. Press Regenerate (or switch to a stronger section model in Settings) and verify before keeping.</div>
                    )}
                    {st.integrity && st.integrity.badIds.length > 0 && (
                      <div className="text-xs text-red-400">Hallucinated source id(s) rejected by validator: {st.integrity.badIds.join(", ")}</div>
                    )}
                    {st.integrity && st.integrity.badPages?.length > 0 && (
                      <div className="text-xs text-amber-300">Citation page mismatch(es) (not found in retrieved passages): {st.integrity.badPages.join(", ")}</div>
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
                              // Only keep citations for paragraphs that still
                              // exist at the same index with identical text;
                              // net-new or rewritten paragraphs get [] (counted
                              // as model-bridged) instead of inherited cites.
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
                                // Citations/claims verified against the old
                                // text are meaningless now — recompute
                                // integrity, drop stale verdicts.
                                integrity: validateSectionCitations(next, st.passages),
                                claims: null,
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
                    <div className="text-sm font-semibold text-white">{quality.citation_total ? `${quality.citation_integrity_pct}%` : "—"}</div>
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
                {quality.citation_page_mismatches.length > 0 && (
                  <div className="space-y-1">
                    {quality.citation_page_mismatches.map((m, i) => (
                      <div key={i} className="text-xs text-amber-300">⚠ Page mismatch: {m} (page cited is not present in retrieved passages for this source)</div>
                    ))}
                  </div>
                )}
                {quality.missing_references.length > 0 && (
                  <div className="text-xs text-amber-300">Missing metadata for: {quality.missing_references.map(titleOf).join(", ")}</div>
                )}
                {quality.malformed_references.length > 0 && (
                  <div className="text-xs text-amber-300">Malformed bibliography entries — koreksi via Edit di Daftar Pustaka bawah (atau metadata sumber): {quality.malformed_references.map(titleOf).join(", ")}</div>
                )}
                {quality.unused_sources.length > 0 && (
                  <div className="text-xs text-[#8e8e8e]">Selected but never cited: {quality.unused_sources.map(titleOf).join(", ")}</div>
                )}
                {quality.redundant_pairs.length > 0 && (
                  <div className="text-xs text-amber-300">Kemungkinan duplikasi: {quality.redundant_pairs.map((p) => `${p.a} ≈ ${p.b} (${p.score})`).join(" · ")} — tekan ↻ Bukti baru pada section yang belakangan (atau pertajam Fokus).</div>
                )}
                {quality.ai_filled > 0 && hybridMode === "off" && (
                  <div className="text-xs text-amber-300">{quality.ai_filled} paragraf tanpa sitasi dalam mode Strict — Regenerate dengan grounding 15/85, atau Edit manual.</div>
                )}
                {quality.ai_filled > 0 && hybridMode !== "off" && (
                  <div className="text-xs text-[#8e8e8e]">{quality.ai_filled} paragraf model-bridged (tanpa sitasi) — wajar di mode {hybridMode}; verifikasi manual sebelum final.</div>
                )}
                {quality.citation_missing_pages.length > 0 && (
                  <div className="text-xs text-[#8e8e8e]">Tanpa halaman (sumbernya punya info halaman, sitasi membuangnya): {quality.citation_missing_pages.join(" · ")} — Regenerate atau tambah manual; bukan error, tapi melemahkan pinpoint.</div>
                )}
                <div className="flex gap-2 flex-wrap pt-1">
                  <button onClick={exportPDF} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium">Export PDF (print)</button>                  <button onClick={copyMarkdown} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">{copied ? "✓ Copied" : "⧉ Copy Markdown"}</button>                  <button onClick={publishToShared} disabled={publishing} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white disabled:opacity-40" title="Publish this paper into Shared chats (same export gates as Copy/Export)">{publishing ? "Publishing…" : "Publish to shared ↑"}</button>
                  <button onClick={refreshReferences} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">↻ Refresh references</button>
                  <button onClick={() => setStep(3)} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-5 py-2 text-sm text-white">← Back to drafting</button>
                </div>
                {exportNote && <div className="text-xs text-amber-300">{exportNote}</div>}
              </div>

              <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-sm font-medium text-white">Daftar Pustaka — {references.length} entri</div>
                  <span className="text-[11px] text-[#5f5f5f]">otomatis dari metadata; klik Edit untuk isi/koreksi manual per entri. Refresh hanya menambah yang hilang, tidak menimpa editan.</span>
                </div>
                {!references.length && <div className="text-xs text-[#5f5f5f]">Belum ada — Generate sections dulu, lalu Refresh references.</div>}
                {references.map((r) => (
                  <div key={r.id} className="rounded-xl bg-[#171717] border border-[#2f2f2f] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#5f5f5f] truncate flex-1" title={r.id}>{titleOf(r.id)}</span>
                      {r.manual && <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-emerald-900 text-emerald-400">manual</span>}
                      {isMalformedReference(r.formatted_apa7) && !r.manual && <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-800 text-amber-300">perlu koreksi</span>}
                      {editingRef !== r.id && (
                        <button
                          onClick={() => { setEditingRef(r.id); setRefEditText(r.formatted_apa7); }}
                          className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-0.5 bg-black"
                        >✎ Edit</button>
                      )}
                    </div>
                    {editingRef === r.id ? (
                      <div className="mt-2 space-y-2">
                        <textarea value={refEditText} onChange={(e) => setRefEditText(e.target.value)} rows={3} className="w-full rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 text-sm text-white" />
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setEditingRef(null)} className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e]">Batal</button>
                          <button
                            onClick={() => {
                              const text = refEditText.trim();
                              if (!text) return;
                              setReferences((prev) => prev.map((x) => x.id === r.id ? { ...x, formatted_apa7: text, manual: true } : x));
                              setEditingRef(null);
                            }}
                            className="rounded-full bg-white text-black px-3 py-1 text-xs font-medium"
                          >Simpan</button>
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
                    {[cover.author && `${cover.author}${cover.nim ? ` — ${cover.nim}` : ""}`, cover.course, cover.lecturer].filter(Boolean).join(" • ")}
                  </div>
                )}
                {flatByChapter.map(({ ch, items }, ci) => (
                  <div key={ci}>
                    <h2 className="text-base font-semibold text-white mt-2">{ch.chapter_number} {ch.chapter_title}</h2>
                    {items.map((item) => {
                      const st = secs[item.key];
                      return (
                        <div key={item.key} className="mt-2">
                          <h3 className="text-sm font-medium text-[#ececec]">{item.sub.number} {item.sub.title}</h3>
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
