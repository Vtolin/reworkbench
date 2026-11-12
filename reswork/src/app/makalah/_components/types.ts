import { MAKALAH_DEFAULT_CHAPTERS } from "@/contexts/MakalahContext";
import type {
  MakalahHybrid,
  OutlineChapter,
  OutlineSubsection,
  SectionOutput,
  SectionPassage,
} from "@/lib/wb/makalah";

/** Default template; owned by the draft context so resets never drift. */
export const DEFAULT_CHAPTERS = MAKALAH_DEFAULT_CHAPTERS;

export type SecStatus = "idle" | "retrieving" | "generating" | "ok" | "error";

/** Per-section UI + persisted state for the drafting step. */
export interface SecState {
  status: SecStatus;
  passages: SectionPassage[];
  output: SectionOutput | null;
  error: string | null;
  integrity: { total: number; valid: number; badIds: string[]; badPages: string[] } | null;
  claims: Array<{ verdict: string; reason: string }> | null;
  claimBusy: boolean;
  /** Visible claim-check progress (Phase 7); transient, never persisted. */
  claimProgress: { current: number; total: number } | null;
  editing: boolean;
  editText: string;
}

export const freshSec = (): SecState => ({
  status: "idle",
  passages: [],
  output: null,
  error: null,
  integrity: null,
  claims: null,
  claimBusy: false,
  claimProgress: null,
  editing: false,
  editText: "",
});

/** Collision-free state key for a subsection. */
export const subKey = (chapterNumber: string, number: string) => `${chapterNumber}::${number}`;

export interface MakalahDocItem {
  id: string;
  title: string | null;
  original_filename: string | null;
}

/** One outline subsection together with its chapter and state key. */
export interface FlatItem {
  ch: OutlineChapter;
  sub: OutlineSubsection;
  key: string;
}

/** Flat items grouped by chapter for every renderer/export path. */
export interface ChapterGroup {
  ch: OutlineChapter;
  items: FlatItem[];
}

/** Subsection evidence scope; falls back to AI-proposed sources pre-approval. */
export function resolvedIds(sub: OutlineSubsection): string[] {
  return sub.source_ids ?? sub.likely_sources ?? [];
}

/** Add/remove an id in a multi-select array (stable order, no duplicates). */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export type MakalahMode = "A" | "B";
export type MakalahCoverState = {
  title: string;
  author: string;
  nim: string;
  course: string;
  lecturer: string;
};

export type { MakalahHybrid };
