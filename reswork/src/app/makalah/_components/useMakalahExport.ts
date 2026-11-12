"use client";

// Quality report, bibliography top-up, and the three export paths for the
// Makalah workbench. Export gates are enforced once here so Copy, Publish
// and Print can never ship different documents.

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  SECTION_SALVAGE_MARKER,
  buildQualityReport,
  type MakalahReference,
} from "@/lib/wb/makalah";
import { buildMarkdownDocument, buildPrintHtml } from "@/lib/wb/makalah/document";
import { citedIdsOf, mergeReferences } from "@/lib/wb/makalah/page-support";
import { publishMakalah } from "@/lib/wb/publish";
import type { MakalahDraftModel } from "./useMakalahDraft";

export function useMakalahExport(draft: MakalahDraftModel) {
  const {
    flat,
    flatByChapter,
    outline,
    secs,
    references,
    setReferences,
    selected,
    titleOf,
    cover,
    topic,
    language,
    setStep,
  } = draft;

  const [copied, setCopied] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [refEditText, setRefEditText] = useState("");

  const isID = language.toLowerCase().startsWith("id");
  const docTitle = cover.title.trim() || topic.trim() || "Makalah";

  const citedIds = useMemo(
    () => citedIdsOf(Object.values(secs).map((s) => s.output)),
    [secs],
  );

  const quality = useMemo(
    () =>
      buildQualityReport({
        sections: flat,
        states: secs,
        references,
        citedIds,
        selected,
        outline,
        titleOf,
      }),
    [flat, secs, references, citedIds, selected, outline, titleOf],
  );

  // References go stale when sections are (re)generated one by one instead of
  // via Generate-all — top up the missing ones before preview/export/copy so
  // Daftar Pustaka is never silently empty. Failures are RETURNED, never
  // swallowed: callers turn them into an export-blocking message.
  const ensureReferences = async (): Promise<{
    refs: MakalahReference[];
    error: string | null;
  }> => {
    const missing = citedIdsOf(flat.map((item) => secs[item.key]?.output ?? null)).filter(
      (id) => !references.some((r) => r.id === id),
    );
    if (!missing.length) return { refs: references, error: null };
    try {
      const fresh = await api.makalahReferences(missing);
      const merged = mergeReferences(references, fresh);
      setReferences(merged);
      return { refs: merged, error: null };
    } catch (e) {
      return {
        refs: references,
        error: e instanceof Error ? e.message : "Refresh references gagal",
      };
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
      setExportNote(
        `Refresh references gagal: ${
          e instanceof Error ? e.message : "unknown error"
        }. Periksa koneksi / login, lalu coba lagi.`,
      );
    }
  };

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
      (item) => secs[item.key]?.status !== "ok" || !secs[item.key]?.output,
    );
    const salvage = flat.filter((item) =>
      secs[item.key]?.output?.gaps.includes(SECTION_SALVAGE_MARKER),
    );
    const errs: string[] = [];
    if (missing.length) {
      errs.push(
        `Belum lengkap: ${missing
          .map((f) => `${f.sub.number} ${f.sub.title}`)
          .join(", ")} — Generate/Regenerate dulu.`,
      );
    }
    if (salvage.length) {
      errs.push(
        `Tanpa sitasi (gagal JSON): ${salvage
          .map((f) => `${f.sub.number} ${f.sub.title}`)
          .join(", ")} — Regenerate atau Edit manual dulu.`,
      );
    }
    const citedNow = citedIdsOf(flat.map((item) => secs[item.key]?.output ?? null));
    const missingRefs = citedNow.filter((id) => !refs.some((r) => r.id === id));
    if (missingRefs.length) {
      errs.push(
        `Daftar Pustaka belum lengkap (${missingRefs.length} sumber: ${missingRefs
          .map((id) => titleOf(id))
          .join(", ")}) — metadata gagal dimuat, periksa koneksi lalu tekan Refresh references.`,
      );
    }
    return errs;
  };

  const buildMarkdown = (refs: MakalahReference[] = references): string =>
    buildMarkdownDocument({
      docTitle,
      isID,
      groups: flatByChapter,
      states: secs,
      refs,
      titleOf,
    });

  const copyMarkdown = async () => {
    const { refs, error } = await ensureReferences();
    if (error) {
      setExportNote(
        `Tidak bisa copy — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`,
      );
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
    } catch {
      /* clipboard unavailable */
    }
  };

  const publishToShared = async () => {
    if (publishing) return;
    setExportNote(null);
    setPublishing(true);
    try {
      const { refs, error } = await ensureReferences();
      if (error) {
        setExportNote(
          `Tidak bisa publish — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`,
        );
        return;
      }
      const blockers = exportBlockers(refs);
      if (blockers.length) {
        setExportNote(`Tidak bisa publish — ${blockers.join(" ")}`);
        return;
      }
      await publishMakalah({
        title: docTitle,
        markdown: buildMarkdown(refs),
        topic: topic.trim(),
        language,
      });
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
      setExportNote(
        `Tidak bisa export — Daftar Pustaka gagal dimuat: ${error}. Periksa koneksi lalu tekan Refresh references.`,
      );
      return;
    }
    const blockers = exportBlockers(refs);
    if (blockers.length) {
      setExportNote(`Tidak bisa export — ${blockers.join(" ")}`);
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      setExportNote(
        "Popup blocked — allow popups for this site, then press Export PDF again.",
      );
      return;
    }
    w.document.write(
      buildPrintHtml({
        docTitle,
        isID,
        language,
        cover,
        outline,
        groups: flatByChapter,
        states: secs,
        refs,
        titleOf,
      }),
    );
    w.document.close();
    w.focus();
    w.print();
  };

  const startEditRef = (ref: MakalahReference) => {
    setEditingRef(ref.id);
    setRefEditText(ref.formatted_apa7);
  };

  const saveEditRef = (id: string) => {
    const text = refEditText.trim();
    if (!text) return;
    setReferences((prev) =>
      prev.map((x) => (x.id === id ? { ...x, formatted_apa7: text, manual: true } : x)),
    );
    setEditingRef(null);
  };

  /** Preview button: top up bibliography, note failures, then open step 4. */
  const openPreview = async () => {
    const result = await ensureReferences();
    if (result.error) {
      setExportNote(`Daftar Pustaka gagal dimuat: ${result.error}. Tekan Refresh references.`);
    }
    setStep(4);
  };

  return {
    copied,
    exportNote,
    setExportNote,
    publishing,
    editingRef,
    setEditingRef,
    refEditText,
    setRefEditText,
    startEditRef,
    saveEditRef,
    isID,
    docTitle,
    quality,
    ensureReferences,
    refreshReferences,
    exportBlockers,
    buildMarkdown,
    copyMarkdown,
    publishToShared,
    exportPDF,
    openPreview,
  };
}

export type MakalahExportModel = ReturnType<typeof useMakalahExport>;
