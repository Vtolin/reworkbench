// Library reindex: rebuild document embeddings in the browser.
//
// Scope is deliberately embeddings-only (never chunks, never metadata):
//  - RLS lets members INSERT chunks but only admins UPDATE/DELETE them
//    (0006 chunks_member_insert / chunks_admin_write), while embeddings
//    allow member INSERT + DELETE (0003 embeddings_insert/delete, kept in
//    0006) with UPDATE admin-only. Delete + bulk re-insert is therefore the
//    member-safe repair shape; in-place updates would 403 for non-admins.
//  - Chunks are the FTS source of truth; rewriting them would fork search
//    text from vectors. Reindex re-derives vectors from stored chunk content.
//
// Two modes:
//  - "missing": delegate to reembedMissingEmbeddings (ingest.ts) — fills
//    exactly the chunks lacking vectors, skips the rest. Cheapest.
//  - "full": delete every embedding of the target documents, then embed all
//    chunks fresh (embedding-model change, suspected drift, post-migration).
//    Serial per document, bounded chunk parallelism (4, like confirm).
//
// Admin-triggered from the Admin ingest-health panel, never polled. One
// logEvent per run. lib-boundary: browser client only, no UI imports.
import { createClient } from "@/lib/supabase/client";
import { chunkArray, mapWithLimit } from "@/lib/async/pool";
import { errorCategory, logEvent } from "@/lib/observability/log";
import {
  embedSlice,
  reembedMissingEmbeddings,
  type ReembedSummary,
} from "./ingest";
import { getWorkspaceId } from "./library";

export type ReindexScope = "missing" | "full";

/** Row bound when no explicit docIds are given (matches the duplicate-
 *  detection window in ingest.ts: order-independent, deterministic). */
export const REINDEX_LIST_LIMIT = 2000;

export interface ReindexSummary {
  docsScanned: number;
  docsFixed: number;
  chunksEmbedded: number;
  chunksSkipped: number;
  chunksDeleted: number;
  warnings: string[];
}

function emptySummary(): ReindexSummary {
  return {
    docsScanned: 0,
    docsFixed: 0,
    chunksEmbedded: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    warnings: [],
  };
}

function fromReembed(s: ReembedSummary): ReindexSummary {
  return { ...s, chunksDeleted: 0 };
}

/** Workspace document ids, newest first, bounded (never an unbounded IN). */
export async function listReindexTargets(): Promise<string[]> {
  const sb = createClient();
  const ws = await getWorkspaceId();
  const { data, error } = await sb
    .from("documents")
    .select("id")
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(REINDEX_LIST_LIMIT);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Rebuild embeddings for the target documents.
 * Idempotent: re-running after a partial run re-embeds whatever is still
 * missing (deleted-then-failed chunks are just "missing" again). A document
 * whose chunks fail to embed keeps its error status with the reason — the
 * same visibility contract as confirmIngest.
 */
export async function reindexDocuments(opts: {
  scope: ReindexScope;
  docIds?: string[];
  embedMode: "local" | "server";
  onProgress?: (done: number, total: number) => void;
}): Promise<ReindexSummary> {
  if (opts.scope === "missing") {
    const started = Date.now();
    const s = await reembedMissingEmbeddings({
      embedMode: opts.embedMode,
      docIds: opts.docIds,
      onProgress: opts.onProgress,
    });
    const out = fromReembed(s);
    logEvent(s.warnings.length ? "warn" : "info", "ingest.reindex", {
      scope: "missing",
      docsScanned: out.docsScanned,
      docsFixed: out.docsFixed,
      chunksEmbedded: out.chunksEmbedded,
      chunksSkipped: out.chunksSkipped,
      warnings: out.warnings.length,
      durationMs: Date.now() - started,
      ok: s.warnings.length === 0,
    });
    return out;
  }
  return reindexFull(opts);
}

async function reindexFull(opts: {
  docIds?: string[];
  embedMode: "local" | "server";
  onProgress?: (done: number, total: number) => void;
}): Promise<ReindexSummary> {
  const sb = createClient();
  const ws = await getWorkspaceId();
  const summary = emptySummary();
  const started = Date.now();
  const targetIds = opts.docIds ?? (await listReindexTargets());
  summary.docsScanned = targetIds.length;
  let done = 0;
  // Serial per document: one delete + one embed fan-out (4) + one insert in
  // flight at a time. Parallel documents would multiply embed pressure and
  // interleave deletes/inserts on shared tables for no latency win on the
  // free tier (PostgREST + pooler connections are the bottleneck, not us).
  for (const docId of targetIds) {
    done++;
    opts.onProgress?.(done, targetIds.length);
    const { data: chunkRows, error: chunkErr } = await sb
      .from("document_chunks")
      .select("id, content")
      .eq("workspace_id", ws)
      .eq("document_id", docId)
      .order("chunk_index");
    if (chunkErr) {
      summary.warnings.push(`document ${docId.slice(0, 8)}: chunks unreadable (${chunkErr.message})`);
      continue;
    }
    const chunks = (chunkRows ?? []) as Array<{ id: string; content: string }>;
    if (!chunks.length) {
      summary.warnings.push(`document ${docId.slice(0, 8)}: no chunks stored — re-upload required`);
      continue;
    }
    // Delete-then-insert (never UPDATE: embeddings UPDATE is admin-only RLS,
    // 0006 embeddings_admin_update). Batched so the IN list stays bounded.
    let deleted = 0;
    let deleteFailed = false;
    for (const batch of chunkArray(chunks.map((c) => c.id))) {
      const { error: delErr } = await sb
        .from("document_embeddings")
        .delete()
        .in("chunk_id", batch);
      if (delErr) {
        summary.warnings.push(`document ${docId.slice(0, 8)}: vectors not cleared (${delErr.message})`);
        deleteFailed = true;
        break;
      }
      deleted += batch.length;
    }
    if (deleteFailed) continue;
    summary.chunksDeleted += deleted;
    let embedRows: Array<{ chunk_id: string; embedding: number[]; model_name: string }>;
    try {
      embedRows = await mapWithLimit(chunks, 4, async (chunk) => ({
        chunk_id: chunk.id,
        ...(await embedSlice(chunk.content, opts.embedMode)),
      }));
    } catch (e) {
      summary.warnings.push(
        `document ${docId.slice(0, 8)}: embed failed (${e instanceof Error ? e.message : "unknown"}) — vectors cleared, retry to refill`,
      );
      await sb
        .from("documents")
        .update({ ingestion_status: "error", ingestion_error: "Reindex embed failed — retry to refill vectors" })
        .eq("id", docId);
      continue;
    }
    const { error: insErr } = await sb.from("document_embeddings").insert(embedRows);
    if (insErr) {
      summary.warnings.push(`document ${docId.slice(0, 8)}: vectors not stored (${insErr.message})`);
      await sb
        .from("documents")
        .update({ ingestion_status: "error", ingestion_error: `Reindex store failed: ${insErr.message.slice(0, 300)}` })
        .eq("id", docId);
      continue;
    }
    summary.chunksEmbedded += embedRows.length;
    summary.docsFixed++;
    const { data: cur } = await sb
      .from("documents")
      .select("ingestion_status")
      .eq("id", docId)
      .maybeSingle();
    if (cur && (cur as { ingestion_status: string }).ingestion_status === "error") {
      const { error: flipErr } = await sb
        .from("documents")
        .update({ ingestion_status: "ready", ingestion_error: null })
        .eq("id", docId);
      if (flipErr) summary.warnings.push(`document ${docId.slice(0, 8)}: vectors stored but status flip blocked (${flipErr.message})`);
    }
  }
  logEvent(summary.warnings.length ? "warn" : "info", "ingest.reindex", {
    scope: "full",
    docsScanned: summary.docsScanned,
    docsFixed: summary.docsFixed,
    chunksEmbedded: summary.chunksEmbedded,
    chunksSkipped: summary.chunksSkipped,
    chunksDeleted: summary.chunksDeleted,
    warnings: summary.warnings.length,
    embedMode: opts.embedMode,
    durationMs: Date.now() - started,
    ok: summary.warnings.length === 0,
    ...(summary.warnings.length ? { errorCategory: errorCategory(summary.warnings[0]) } : {}),
  });
  return summary;
}
