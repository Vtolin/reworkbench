"use client";
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { OutlineChapter, SectionOutput, SectionPassage, MakalahReference } from "@/lib/wb/makalah";

/** Persisted per-section state (transient UI flags excluded). */
export interface MakalahSecPersisted {
  status: "idle" | "retrieving" | "generating" | "ok" | "error";
  passages: SectionPassage[];
  output: SectionOutput | null;
  error: string | null;
  integrity: { total: number; valid: number; badIds: string[] } | null;
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

/** Normalize a stored draft (mid-flight statuses can't survive a reload). */
function normalize(d: MakalahDraft): MakalahDraft {
  const secs: Record<string, MakalahSecPersisted> = {};
  for (const [k, s] of Object.entries(d.secs ?? {})) {
    secs[k] = {
      status: s.status === "ok" || s.status === "error" ? s.status : "idle",
      passages: Array.isArray(s.passages) ? s.passages : [],
      output: s.output ?? null,
      error: typeof s.error === "string" ? s.error : null,
      integrity: s.integrity ?? null,
      claims: Array.isArray(s.claims) ? s.claims : null,
    };
  }
  return {
    ...blankSnapshot(),
    ...d,
    outline: Array.isArray(d.outline) ? d.outline : [],
    selected: Array.isArray(d.selected) ? d.selected : [],
    references: Array.isArray(d.references) ? d.references : [],
    cover: { ...blankSnapshot().cover, ...(d.cover ?? {}) },
    step: Math.min(4, Math.max(1, Number(d.step) || 1)),
    secs,
  };
}

export function MakalahProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<MakalahDraft[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY_DOCS);
      let list: MakalahDraft[] = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      list = list.map(normalize);
      if (!list.length) list = [freshDraft()];
      let active = localStorage.getItem(KEY_ACTIVE);
      if (!active || !list.some((d) => d.id === active)) active = list[0].id;
      // newest first
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      setDrafts(list);
      setActiveId(active);
    } catch {
      const d = freshDraft();
      setDrafts([d]);
      setActiveId(d.id);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(KEY_DOCS, JSON.stringify(drafts));
    } catch {
      /* quota — keep in-memory */
    }
  }, [drafts, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(KEY_ACTIVE, activeId || "");
    } catch {}
  }, [activeId, hydrated]);

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
      value={{ drafts, activeId, hydrated, newDraft, selectDraft, deleteDraft, saveDraft }}
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
