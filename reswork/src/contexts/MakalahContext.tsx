"use client";
import React, { createContext, useContext, useCallback } from "react";
import type { OutlineChapter, SectionOutput, SectionPassage, MakalahReference, MakalahHybrid } from "@/lib/wb/makalah";
import { useLocalStorageList } from "./localStorage";

/** Persisted per-section state (transient UI flags excluded). */
export interface MakalahSecPersisted {
  status: "idle" | "retrieving" | "generating" | "ok" | "error";
  passages: SectionPassage[];
  output: SectionOutput | null;
  error: string | null;
  integrity: { total: number; valid: number; badIds: string[]; badPages: string[] } | null;
  claims: Array<{ verdict: string; reason: string }> | null;
}

export interface MakalahCover {
  title: string;
  author: string;
  nim: string;
  course: string;
  lecturer: string;
}

export interface MakalahSnapshot {
  topic: string;
  language: string;
  academicLevel: string;
  selected: string[];
  mode: "A" | "B";
  chaptersText: string;
  minSubs: number;
  maxSubs: number;
  targetWords: number;
  citationStyle: string;
  /** Grounding mode for section drafting (off / 15/85 / 30/70). */
  hybridMode: MakalahHybrid;
  cover: MakalahCover;
  outline: OutlineChapter[];
  coverageNotes: string;
  approved: boolean;
  secs: Record<string, MakalahSecPersisted>;
  references: MakalahReference[];
  step: number;
}

export interface MakalahDraft extends MakalahSnapshot {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export const MAKALAH_DEFAULT_CHAPTERS = "BAB I Pendahuluan\nBAB II Pembahasan\nBAB III Penutup";

export function blankSnapshot(): MakalahSnapshot {
  return {
    topic: "",
    language: "id-ID",
    academicLevel: "undergraduate",
    selected: [],
    mode: "A",
    chaptersText: MAKALAH_DEFAULT_CHAPTERS,
    minSubs: 2,
    maxSubs: 5,
    targetWords: 300,
    citationStyle: "APA 7",
    hybridMode: "15/85",
    cover: { title: "", author: "", nim: "", course: "", lecturer: "" },
    outline: [],
    coverageNotes: "",
    approved: false,
    secs: {},
    references: [],
    step: 1,
  };
}

export function draftTitle(d: MakalahSnapshot): string {
  return d.cover.title.trim() || d.topic.trim() || "New makalah";
}

export function draftProgress(d: MakalahSnapshot): { done: number; total: number } {
  const total = d.outline.reduce((n, ch) => n + ch.subsections.length, 0);
  let done = 0;
  for (const ch of d.outline) {
    for (const sub of ch.subsections) {
      if (d.secs[`${ch.chapter_number}::${sub.number}`]?.status === "ok") done += 1;
    }
  }
  return { done, total };
}

function isBlank(d: MakalahSnapshot): boolean {
  return (
    !d.topic.trim() &&
    !d.outline.length &&
    !Object.values(d.secs).some((s) => s.output)
  );
}

type MakalahState = {
  drafts: MakalahDraft[];
  activeId: string | null;
  hydrated: boolean;
  /** Non-null when the last autosave failed (e.g. localStorage quota). */
  persistError: string | null;
  newDraft: () => string;
  selectDraft: (id: string) => void;
  deleteDraft: (id: string) => void;
  saveDraft: (id: string, snap: MakalahSnapshot) => void;
};

const KEY_DOCS = "wb_makalah_drafts_v1";
const KEY_ACTIVE = "wb_makalah_active_v1";

const MakalahContext = createContext<MakalahState | null>(null);

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function freshDraft(): MakalahDraft {
  const now = Date.now();
  return { ...blankSnapshot(), id: uid(), createdAt: now, updatedAt: now };
}

/**
 * Normalize a stored draft (mid-flight statuses can't survive a reload).
 * This is the resume checkpoint rule: finished outputs/passages/claims
 * survive a closed tab; in-flight work resets to idle for an explicit
 * re-run instead of a phantom "generating" state.
 */
export function normalize(d: MakalahDraft): MakalahDraft {
  const secs: Record<string, MakalahSecPersisted> = {};
  for (const [k, s] of Object.entries(d.secs ?? {})) {
    secs[k] = {
      status: s.status === "ok" || s.status === "error" ? s.status : "idle",
      passages: Array.isArray(s.passages) ? s.passages : [],
      output: s.output ?? null,
      error: typeof s.error === "string" ? s.error : null,
      integrity: s.integrity
        ? {
            total: Number(s.integrity.total) || 0,
            valid: Number(s.integrity.valid) || 0,
            badIds: Array.isArray(s.integrity.badIds) ? s.integrity.badIds : [],
            badPages: Array.isArray(s.integrity.badPages) ? s.integrity.badPages : [],
          }
        : null,
      claims: Array.isArray(s.claims) ? s.claims : null,
    };
  }
  return {
    ...blankSnapshot(),
    ...d,
    hybridMode: d.hybridMode === "off" || d.hybridMode === "30/70" ? d.hybridMode : "15/85",
    outline: Array.isArray(d.outline) ? d.outline : [],
    selected: Array.isArray(d.selected) ? d.selected : [],
    references: Array.isArray(d.references) ? d.references : [],
    cover: { ...blankSnapshot().cover, ...(d.cover ?? {}) },
    step: Math.min(4, Math.max(1, Number(d.step) || 1)),
    secs,
  };
}

export function MakalahProvider({ children }: { children: React.ReactNode }) {
  // Hydrate/persist via the shared hook (Phase 6): normalization, newest-
  // first order, messages and timing identical to the inline code replaced.
  const {
    items: drafts,
    activeId,
    setItems: setDrafts,
    setActiveId,
    hydrated,
    persistError,
  } = useLocalStorageList<MakalahDraft>({
    itemsKey: KEY_DOCS,
    activeKey: KEY_ACTIVE,
    parseItems: (raw) => (Array.isArray(raw) ? (raw as MakalahDraft[]).map(normalize) : []),
    getId: (d) => d.id,
    freshItem: freshDraft,
    sort: (list) => [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    messages: {
      quotaMessage: "Penyimpanan browser penuh — draft hanya ada di memori tab ini. Export/Copy sekarang, lalu hapus draft lama.",
      failureMessage: "Autosave gagal — draft hanya ada di memori tab ini. Export/Copy sekarang.",
    },
  });

  const newDraft = useCallback((): string => {
    const active = drafts.find((d) => d.id === activeId);
    // reuse an already-blank active draft instead of piling up empties
    if (active && isBlank(active)) return active.id;
    const d = freshDraft();
    setDrafts((prev) => [d, ...prev]);
    setActiveId(d.id);
    return d.id;
  }, [drafts, activeId]);

  const selectDraft = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const deleteDraft = useCallback((id: string) => {
    const filtered = drafts.filter((d) => d.id !== id);
    const remaining = filtered.length ? filtered : [freshDraft()];
    setDrafts(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  }, [drafts, activeId]);

  const saveDraft = useCallback((id: string, snap: MakalahSnapshot) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...snap, updatedAt: Date.now() } : d)),
    );
  }, []);

  return (
    <MakalahContext.Provider
      value={{ drafts, activeId, hydrated, persistError, newDraft, selectDraft, deleteDraft, saveDraft }}
    >
      {children}
    </MakalahContext.Provider>
  );
}

export function useMakalah() {
  const ctx = useContext(MakalahContext);
  if (!ctx) throw new Error("useMakalah must be used within MakalahProvider");
  return ctx;
}
