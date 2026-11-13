"use client";

// Draft state owner for the Makalah workbench: setup fields, outline history,
// per-section state and the autosave bridge into MakalahContext. Generation
// and export read this model; they never duplicate its state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useMakalah, blankSnapshot, type MakalahSnapshot } from "@/contexts/MakalahContext";
import {
  refineOutline,
  stripLeakedCitations,
  stripTitleEchoes,
  type MakalahHybrid,
  type MakalahReference,
  type OutlineChapter,
  type OutlineSubsection,
} from "@/lib/wb/makalah";
import { parseChapterLine } from "@/lib/wb/makalah/page-support";
import {
  DEFAULT_CHAPTERS,
  freshSec,
  resolvedIds,
  subKey,
  toggleId,
  type ChapterGroup,
  type FlatItem,
  type MakalahCoverState,
  type MakalahDocItem,
  type MakalahMode,
  type SecState,
} from "./types";

function sanitizeOutline(chs: OutlineChapter[], selected: string[]): OutlineChapter[] {
  return chs.map((ch) => ({
    ...ch,
    subsections: ch.subsections.map((s) => ({
      ...s,
      likely_sources: (s.likely_sources ?? []).filter((id) => selected.includes(id)),
      source_ids: s.source_ids ? s.source_ids.filter((id) => selected.includes(id)) : undefined,
    })),
  }));
}

export function useMakalahDraft() {
  const { drafts, activeId, hydrated, persistError, newDraft, selectDraft, saveDraft } =
    useMakalah();

  const [step, setStep] = useState(1);
  const [docs, setDocs] = useState<MakalahDocItem[]>([]);
  // Bound history draft (null until context hydrates) + drawer.
  const [docId, setDocId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Setup
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("id-ID");
  const [academicLevel, setAcademicLevel] = useState("undergraduate");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<MakalahMode>("A");
  const [chaptersText, setChaptersText] = useState(DEFAULT_CHAPTERS);
  const [minSubs, setMinSubs] = useState(2);
  const [maxSubs, setMaxSubs] = useState(5);
  const [targetWords, setTargetWords] = useState(300);
  const [citationStyle, setCitationStyle] = useState("APA 7");
  const [hybridMode, setHybridMode] = useState<MakalahHybrid>("15/85");
  const [cover, setCover] = useState<MakalahCoverState>({
    title: "",
    author: "",
    nim: "",
    course: "",
    lecturer: "",
  });

  // Outline
  const [outline, setOutline] = useState<OutlineChapter[]>([]);
  const [coverageNotes, setCoverageNotes] = useState("");
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [refineNote, setRefineNote] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  // Drafting
  const [secs, setSecs] = useState<Record<string, SecState>>({});
  // Mirror of secs for async callbacks (closures capture stale state mid-loop).
  // Assigned in an effect (not during render): only async continuations read
  // it, and effects flush after every commit, so the mirror always matches
  // the last committed state.
  const secsMirror = useRef<Record<string, SecState>>({});
  useEffect(() => {
    secsMirror.current = secs;
  });

  // Result
  const [references, setReferences] = useState<MakalahReference[]>([]);

  useEffect(() => {
    api
      .listDocuments({})
      .then((r) => setDocs(r.documents))
      .catch(() => {});
  }, []);

  const titleOf = useCallback(
    (id: string) => {
      // Unmapped alias leaking into render (validator flags these) - never
      // show a raw "S2" as if it were a document title.
      if (/^S\d+$/i.test(id.trim())) return `Sumber ${id.trim().toUpperCase()} (tak terpetakan)`;
      return (
        docs.find((d) => d.id === id)?.title ||
        docs.find((d) => d.id === id)?.original_filename ||
        id.slice(0, 8)
      );
    },
    [docs],
  );

  // id → display title for every known doc; sent to the engine so title-echo
  // leaks can be stripped precisely (generic: works for any topic/language).
  const allTitles = useMemo(
    () => Object.fromEntries(docs.map((d) => [d.id, d.title || d.original_filename || d.id])),
    [docs],
  );

  const flat = useMemo(() => {
    // Subsection numbers are user-editable, so duplicates are possible -
    // disambiguate to keep per-section state (and React keys) collision-free.
    const seen = new Set<string>();
    return outline.flatMap((ch, ci) =>
      ch.subsections.map((sub, si) => {
        let key = subKey(ch.chapter_number, sub.number);
        if (seen.has(key)) key = `${key}#${ci}.${si}`;
        seen.add(key);
        const item: FlatItem = { ch, sub, key };
        return item;
      }),
    );
  }, [outline]);

  // Chapter-grouped flat items: every renderer (Markdown, PDF, preview)
  // looks sections up by collision-free item.key - never by raw
  // chapter+number, which duplicates and breaks the export gate contract.
  const flatByChapter = useMemo(() => {
    const groups: ChapterGroup[] = [];
    for (const item of flat) {
      const g = groups.find((x) => x.ch === item.ch);
      if (g) g.items.push(item);
      else groups.push({ ch: item.ch, items: [item] });
    }
    return groups;
  }, [flat]);

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
    setHybridMode(
      snap.hybridMode === "off" || snap.hybridMode === "30/70" ? snap.hybridMode : "15/85",
    );
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
  };

  const resetWorkbench = () => applySnapshot(blankSnapshot());

  // Bind to the active draft once the context hydrates.
  useEffect(() => {
    if (!hydrated || docId) return;
    const target = drafts.find((d) => d.id === activeId) ?? drafts[0];
    if (!target) return;
    setDocId(target.id);
    applySnapshot(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // If the bound draft disappears (deleted in the panel), fall back.
  useEffect(() => {
    if (!hydrated || !docId) return;
    if (drafts.some((d) => d.id === docId)) return;
    const fallback = drafts.find((d) => d.id === activeId) ?? drafts[0];
    if (!fallback) return;
    setDocId(fallback.id);
    applySnapshot(fallback);
  }, [hydrated, docId, drafts, activeId]);

  // Autosave the working state into the bound draft (debounced).
  useEffect(() => {
    if (!hydrated || !docId) return;
    const persistedSecs: MakalahSnapshot["secs"] = {};
    for (const [k, s] of Object.entries(secs)) {
      persistedSecs[k] = {
        status: s.status,
        passages: s.passages,
        output: s.output,
        error: s.error,
        integrity: s.integrity,
        claims: s.claims,
      };
    }
    const snap: MakalahSnapshot = {
      topic,
      language,
      academicLevel,
      selected,
      mode,
      chaptersText,
      minSubs,
      maxSubs,
      targetWords,
      citationStyle,
      hybridMode,
      cover,
      outline,
      coverageNotes,
      approved,
      secs: persistedSecs,
      references,
      step,
    };
    const t = setTimeout(() => saveDraft(docId, snap), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hydrated,
    docId,
    topic,
    language,
    academicLevel,
    selected,
    mode,
    chaptersText,
    minSubs,
    maxSubs,
    targetWords,
    citationStyle,
    hybridMode,
    cover,
    outline,
    coverageNotes,
    approved,
    secs,
    references,
    step,
  ]);

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

  /**
   * 🧹 Deduplicate + dead-end handling on the given outline (defaults to the
   * current one). Prunes drafted state detached by renumbering and resets
   * approval - run before drafting, never after.
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
    setRefineNote(
      bits.length
        ? `🧹 ${bits.join(" · ")}`
        : "🧹 Outline sudah bersih - tidak ada duplikat/dead-end.",
    );
    return next;
  };

  const buildModeBOutline = (): OutlineChapter[] => {
    const lines = chaptersText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
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
    if (!selected.length) {
      setOutlineError("Select at least one source document first.");
      return;
    }
    setOutlineLoading(true);
    setOutlineError(null);
    try {
      const summaries = await api.makalahSources(selected);
      const lines = chaptersText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
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
      const clean = sanitizeOutline(res.outline, selected);
      // Approved shape uses source_ids (keep focus/scope for drafting).
      const fresh = clean.map((ch) => ({
        ...ch,
        subsections: ch.subsections.map((s) => ({
          number: s.number,
          title: s.title,
          source_ids: s.likely_sources ?? [],
          ...(s.focus ? { focus: s.focus } : {}),
          ...(s.must_not_cover?.length ? { must_not_cover: s.must_not_cover } : {}),
        })),
      }));
      // Auto-refine: dedup + dead-end handling straight after generation.
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
      setCoverageNotes(
        stripTitleEchoes(stripLeakedCitations(res.coverage_notes), selected.map(titleOf)),
      );
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
    setOutline((prev) =>
      prev.map((ch, i) =>
        i !== ci
          ? ch
          : {
              ...ch,
              subsections: ch.subsections.map((s, j) => (j !== si ? s : { ...s, ...patch })),
            },
      ),
    );
    setApproved(false);
  };

  const patchChapter = (ci: number, patch: Partial<OutlineChapter>) => {
    setOutline((prev) => prev.map((ch, i) => (i !== ci ? ch : { ...ch, ...patch })));
    setApproved(false);
  };

  const moveSub = (ci: number, si: number, dir: -1 | 1) => {
    setOutline((prev) =>
      prev.map((ch, i) => {
        if (i !== ci) return ch;
        const arr = [...ch.subsections];
        const j = si + dir;
        if (j < 0 || j >= arr.length) return ch;
        [arr[si], arr[j]] = [arr[j], arr[si]];
        return { ...ch, subsections: arr };
      }),
    );
    setApproved(false);
  };

  const addSub = (ci: number) => {
    setOutline((prev) =>
      prev.map((ch, i) => {
        if (i !== ci || ch.subsections.length >= maxSubs) return ch;
        const n = `${ci + 1}.${ch.subsections.length + 1}`;
        return {
          ...ch,
          subsections: [...ch.subsections, { number: n, title: "", source_ids: [] }],
        };
      }),
    );
    setApproved(false);
  };

  const delSub = (ci: number, si: number) => {
    setOutline((prev) =>
      prev.map((ch, i) =>
        i !== ci ? ch : { ...ch, subsections: ch.subsections.filter((_, j) => j !== si) },
      ),
    );
    setApproved(false);
  };

  const toggleSubSource = (ci: number, si: number, id: string) => {
    const cur = resolvedIds(outline[ci].subsections[si]);
    patchSub(ci, si, { source_ids: toggleId(cur, id), likely_sources: undefined });
  };

  const removeChapter = (ci: number) => {
    setOutline((p) => p.filter((_, i) => i !== ci));
    setApproved(false);
  };

  return {
    // context thread
    drafts,
    activeId,
    hydrated,
    persistError,
    docId,
    historyOpen,
    setHistoryOpen,
    openDraft,
    handleNew,
    // step/setup
    step,
    setStep,
    docs,
    topic,
    setTopic,
    language,
    setLanguage,
    academicLevel,
    setAcademicLevel,
    selected,
    setSelected,
    mode,
    setMode,
    chaptersText,
    setChaptersText,
    minSubs,
    setMinSubs,
    maxSubs,
    setMaxSubs,
    targetWords,
    setTargetWords,
    citationStyle,
    setCitationStyle,
    hybridMode,
    setHybridMode,
    cover,
    setCover,
    // outline
    outline,
    setOutline,
    coverageNotes,
    outlineLoading,
    outlineError,
    refineNote,
    approved,
    setApproved,
    applyRefine,
    runOutline,
    startModeB,
    patchSub,
    patchChapter,
    moveSub,
    addSub,
    delSub,
    toggleSubSource,
    removeChapter,
    // drafting state
    secs,
    setSec,
    secsMirror,
    // results
    references,
    setReferences,
    // derived
    titleOf,
    allTitles,
    flat,
    flatByChapter,
  };
}

export type MakalahDraftModel = ReturnType<typeof useMakalahDraft>;
