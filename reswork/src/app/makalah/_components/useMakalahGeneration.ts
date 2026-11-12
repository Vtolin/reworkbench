"use client";

// Section generation loop for the Makalah workbench. The LLM never owns
// control flow: retrieval, loops, retries, and state transitions live here;
// every model call is a pure fixed-input call in lib/wb/makalah.

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  buildNegativeList,
  passageKey,
  sectionFullText,
  validateSectionCitations,
  type OutlineSubsection,
  type SectionOutput,
  type SectionPassage,
} from "@/lib/wb/makalah";
import { sectionSimilarity } from "@/lib/text/similarity";
import {
  buildPrior,
  citedIdsOf,
  isQuotaError,
  mergeReferences,
  scopeNoteOf,
  summarizeOutput,
} from "@/lib/wb/makalah/page-support";
import { isLastChapterKey, isSynthesisKey, synthesisPool } from "./roles";
import { resolvedIds } from "./types";
import type { MakalahDraftModel } from "./useMakalahDraft";

export function useMakalahGeneration(draft: MakalahDraftModel) {
  const {
    flat,
    outline,
    selected,
    topic,
    language,
    citationStyle,
    targetWords,
    hybridMode,
    allTitles,
    secs,
    secsMirror,
    setSec,
    setReferences,
    setStep,
  } = draft;

  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const [autoRetryDup, setAutoRetryDup] = useState(false);
  const stopRef = useRef(false);
  // In-flight generation controller: Stop aborts the model call itself,
  // not just the loop between sections.
  const runSignal = useRef<AbortController | null>(null);
  useEffect(() => () => runSignal.current?.abort(), []);

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
      const query = (
        sub.focus?.trim()
          ? `${distinctive} ${distinctive} ${chTitle} ${topic}`
          : `${distinctive} ${chTitle} ${topic}`
      )
        .replace(/\s+/g, " ")
        .trim();
      // Evidence allocator: used keys go INTO retrieval (widen → exclude →
      // MMR → slice inside retrieveForSection). Post-slice reordering cannot
      // fix a truncated set, so nothing is sorted here. Single regenerations
      // default to excluding every other section's passages (fresh mirror).
      // Synthesis chapters skip the allocator entirely: their pool is the
      // already-cited passages of drafted sections (no new evidence, no
      // disjointness — forcing fresh evidence is what pushed closing
      // subsections off-topic).
      let passages: SectionPassage[];
      if (isSynthesisKey(flat, outline, key)) {
        passages = synthesisPool(flat, secsMirror.current, key);
        if (!passages.length) {
          passages = await api.makalahRetrieve(
            query,
            scope.length ? scope : selected,
            undefined,
            8,
            4,
          );
        }
      } else {
        const usedForCall =
          opts.usedKeys ??
          new Set(
            Object.entries(secsMirror.current)
              .filter(([k]) => k !== key)
              .flatMap(([, s]) => s.passages.map(passageKey)),
          );
        const exclude = usedForCall.size ? [...usedForCall] : undefined;
        passages = await api.makalahRetrieve(
          query,
          scope.length ? scope : selected,
          undefined,
          8,
          4,
          exclude,
        );
      }
      // Fallback: subsection gets 0 passages — widen to chapter+topic across
      // all selected documents before giving up.
      if (!passages.length) {
        passages = await api.makalahRetrieve(
          `${chTitle} ${topic}`.trim(),
          selected.length ? selected : undefined,
          undefined,
          8,
          4,
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
      const output = await api.makalahSection(
        {
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
            is_last_chapter: isLastChapterKey(flat, outline, key),
          },
        },
        opts.signal,
      );
      setSec(key, {
        status: "ok",
        output,
        integrity: validateSectionCitations(output, passages),
      });
      return output;
    } catch (e) {
      const aborted =
        opts.signal?.aborted ||
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
    setRunNote(
      "Dihentikan — hasil sejauh ini tersimpan, teks terakhir yang baik tidak dihapus.",
    );
  };

  const runAll = async () => {
    if (running || !flat.length) return;
    if (!selected.length) {
      setRunNote(
        "Pilih minimal 1 dokumen sumber di Step 1 dulu — tanpa sumber, retrieval berjalan tanpa batas dan sitasi menunjuk dokumen acak.",
      );
      return;
    }
    setRunning(true);
    stopRef.current = false;
    runSignal.current = null;
    setRunNote(null);
    const outputs: Record<string, SectionOutput | null> = {};
    const acc: Array<{
      label: string;
      summary: string;
      text: string;
      output: SectionOutput;
      isClosing: boolean;
    }> = [];
    const used = new Set<string>();
    let retries = 0;
    for (const item of flat) {
      if (stopRef.current) {
        setRunNote("Stopped — generated sections are kept.");
        break;
      }
      const prior = buildPrior(acc);
      const ctrl = new AbortController();
      runSignal.current = ctrl;
      let lastCollected: string[] = [];
      const collect = (psgs: SectionPassage[]) => {
        lastCollected = psgs.map(passageKey);
        for (const k of lastCollected) used.add(k);
      };
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
        const selfClosing = isLastChapterKey(flat, outline, item.key);
        const selfText = sectionFullText(out);
        let worst: { a: (typeof acc)[number]; s: number } | null = null;
        for (const a of acc) {
          const s = sectionSimilarity(selfText, a.text);
          if (!worst || s > worst.s) worst = { a, s };
        }
        const bar = selfClosing || (worst && worst.a.isClosing) ? 0.94 : 0.88;
        if (worst && worst.s >= bar) {
          for (const k of lastCollected) used.delete(k);
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
          isClosing: isLastChapterKey(flat, outline, item.key),
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
        `Incomplete — ${failed.length} section(s) failed: ${failed
          .map((f) => `${f.sub.number} ${f.sub.title}`)
          .join(", ")}. Fix quota/model, Regenerate them, then Preview.`,
      );
    }
    if (retries > 0) {
      setRunNote(
        (prev) =>
          `${prev ? `${prev} ` : ""}${retries}× auto-retry duplikasi dijalankan (evidence baru + daftar kalimat terlarang).`,
      );
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
        if (s > bestS) {
          bestS = s;
          bestOut = mirror[f.key]!.output!;
        }
      }
      if (bestOut) negativeList = buildNegativeList(bestOut);
    }
    let collected: SectionPassage[] = [];
    // Synthesis sections reuse the fixed cited pool by design, so evidence
    // cannot diverge — variance comes from mild sampling on Ollama and from
    // the verbatim negative list on cloud (Gemini 3 ignores temperature).
    const synth = isSynthesisKey(flat, outline, key);
    const out = await runOne(key, chTitle, sub, {
      usedKeys: used,
      collectPassages: (psgs) => {
        collected = psgs;
      },
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

  return {
    running,
    runNote,
    autoRetryDup,
    setAutoRetryDup,
    runOne,
    runAll,
    stopAll,
    regenFresh,
  };
}

export type MakalahGenerationModel = ReturnType<typeof useMakalahGeneration>;
