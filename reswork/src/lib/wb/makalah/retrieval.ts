// Makalah evidence retrieval (deterministic, no LLM).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { createClient } from "../../supabase/client";
import { retrieveContext } from "../../rag/retrieve";
import { mmrSelect } from "../../text/similarity";
import type { InferenceSelection } from "../ask";
import { getWorkspaceId } from "../library";
import { toSectionPassage, type SectionPassage, type SourceSummary } from "./types";

export async function getSourceSummaries(docIds: string[]): Promise<SourceSummary[]> {
  if (!docIds.length) return [];
  const sb = createClient();
  const { data: docs } = await sb
    .from("documents")
    .select("id, title, original_filename, abstract")
    .in("id", docIds);
  const rows = (docs ?? []) as Array<{
    id: string;
    title: string | null;
    original_filename: string | null;
    abstract: string | null;
  }>;
  // Fall back to the first chunk when a doc has no abstract.
  const missing = rows.filter((d) => !(d.abstract ?? "").trim()).map((d) => d.id);
  const firstChunks = new Map<string, string>();
  if (missing.length) {
    const { data: chunks } = await sb
      .from("document_chunks")
      .select("document_id, content, chunk_index")
      .in("document_id", missing)
      .order("chunk_index")
      .limit(missing.length * 2);
    for (const c of (chunks ?? []) as Array<{
      document_id: string;
      content: string;
      chunk_index: number;
    }>) {
      if (!firstChunks.has(c.document_id)) firstChunks.set(c.document_id, c.content);
    }
  }
  return rows.map((d) => ({
    id: d.id,
    title: d.title || d.original_filename || d.id.slice(0, 8),
    abstract_or_excerpt: (
      (d.abstract ?? "").trim() ||
      (firstChunks.get(d.id) ?? "")
    ).slice(0, 600),
  }));
}

// ---------------------------------------------------------------------------
// Retrieval per subsection — deterministic, no LLM
// ---------------------------------------------------------------------------

/**
 * Stable identity for a retrieved passage. Single key space shared by the
 * allocator (excludeKeys), the UI (used-tracking, overlap display) and the
 * validator — never introduce a second key format.
 */
export function passageKey(p: {
  source_id: string;
  page: number | null;
  paragraph: number | null;
}): string {
  return `${p.source_id}::${p.page ?? "?"}::${p.paragraph ?? "?"}`;
}

export async function retrieveForSection(
  query: string,
  scopeIds: string[] | undefined,
  sel: InferenceSelection,
  topK = 8,
  keepTop = 4,
  onStatus?: (stage: string, detail?: string) => void,
  excludeKeys?: Set<string>,
): Promise<SectionPassage[]> {
  const ws = await getWorkspaceId();
  onStatus?.("retrieving", query.slice(0, 80));
  // Widen BEFORE selecting when exclusions exist: post-slice reordering can
  // only permute an already-truncated set, so without a wider pool the
  // "prefer fresh evidence" policy is cosmetic.
  const fetchN = excludeKeys?.size ? Math.max(topK, keepTop * 3) : topK;
  const { passages } = await retrieveContext({
    workspaceId: ws,
    query,
    topN: fetchN,
    embedMode: sel.embedMode,
    scopeIds: scopeIds?.length ? scopeIds : undefined,
    onStatus,
  });
  const pool = passages.map((p, i) => ({
    passage: toSectionPassage({
      document_id: p.document_id,
      page: p.page,
      chunk_index: p.chunk_index ?? null,
      content: p.content,
      score: p.score,
    }),
    rank: i,
  }));
  const fresh = excludeKeys?.size
    ? pool.filter(({ passage }) => !excludeKeys.has(passageKey(passage)))
    : pool;
  // Starvation backfill: an exhausted pool reuses evidence in rank order
  // rather than returning empty (empty would trigger the broaden-fallback
  // loop). Callers detect this by comparing returned keys to excludeKeys.
  const selectable = fresh.length ? fresh : pool;
  const picked = mmrSelect(
    selectable.map(({ passage, rank }) => ({
      key: passageKey(passage),
      relevance: passage.score,
      rank,
      text: passage.text,
      passage,
    })),
    keepTop,
  ).map((x) => x.passage);
  return picked;
}
