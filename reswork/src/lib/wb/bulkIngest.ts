// Bulk document upload + indexing (max MAX_BULK_FILES documents).
//
// Thin batch orchestrator over the single-file pipeline in lib/wb/ingest
// (previewFile / confirmIngest) and lib/wb/ingestRunner (executeIngestFlow).
// It adds NO ingestion logic of its own: per-file work is exactly the
// single-upload path, run serially (document concurrency 1) so a 10-file
// batch costs the same peak resources as one upload, ten times in a row.
//
// Why serial: chunk embedding already fans out to 4 concurrent embed calls
// (ingest.ts); batch-level parallelism would multiply that to 4*N against
// one laptop Ollama (which serializes anyway) or N concurrent bursts against
// /api/rag/embed (per-user budget 120/min — a parallel batch of 10 trips
// 429s mid-batch). Preview is read-only (extract + OpenAlex) and runs at 2.
//
// Quota: Supabase free tier ships ~1GB of storage (see MAX_FILE_BYTES note
// in ingest.ts). One 150MB file can't fill it; ten 150MB files can, so every
// batch is quota-checked up front via readWorkspaceUsage + assessQuota.
//
// lib-boundary note: browser orchestration only (supabase browser client via
// ingest/library helpers). No UI imports — architecture.test.ts forbids
// lib/** runtime imports from app/components/contexts/react.
import { createClient } from "@/lib/supabase/client";
import { mapWithLimit } from "@/lib/async/pool";
import { errorCategory, logEvent } from "@/lib/observability/log";
import {
  confirmIngest,
  previewFile,
  type ConfirmInput,
  type ConfirmedDocument,
  type IngestPreview,
} from "./ingest";
import {
  executeIngestFlow,
  type IngestCandidate,
  type IngestRunnerEdit,
} from "./ingestRunner";
import { getWorkspaceId } from "./library";

/** Hard cap: one batch carries 1..MAX_BULK_FILES files. Enforced here (not
 *  just in the UI) so a modified client can't bypass the picker limit. */
export const MAX_BULK_FILES = 10;

/** Free-tier workspace storage ceiling for the quota pre-check. */
export const WORKSPACE_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

/** Row bound for the usage lookup: approximate past this, never unbounded. */
export const QUOTA_LOOKUP_LIMIT = 5000;

export interface BulkPreviewItem {
  file: File;
  preview: IngestPreview | null;
  /** Set when this file's preview failed; other files are unaffected. */
  error: string | null;
}

export interface BulkConfirmItem {
  file: File;
  preview: IngestPreview;
  edit: IngestRunnerEdit;
  candidate: IngestCandidate | null;
}

export interface BulkConfirmResult {
  fileName: string;
  document: ConfirmedDocument | null;
  indexing_error: string | null;
  /** Hard failure (validation / upload / insert threw). */
  error: string | null;
}

export interface BulkConfirmSummary {
  results: BulkConfirmResult[];
  succeeded: number;
  failed: number;
}

function assertBatchSize(files: readonly File[]): void {
  if (files.length < 1) throw new Error("Choose at least one file");
  if (files.length > MAX_BULK_FILES) {
    throw new Error(`Too many files (max ${MAX_BULK_FILES} per batch)`);
  }
}

/**
 * Preview every file in the batch. Per-file errors are collected, never
 * thrown: one corrupt file must not discard nine good previews.
 * `previewFn` is injectable for tests; production uses previewFile.
 */
export async function previewBulkFiles(
  files: readonly File[],
  previewFn: (file: File) => Promise<IngestPreview> = previewFile,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkPreviewItem[]> {
  assertBatchSize(files);
  let done = 0;
  return mapWithLimit(files, 2, async (file) => {
    try {
      const preview = await previewFn(file);
      return { file, preview, error: null };
    } catch (e) {
      return {
        file,
        preview: null,
        error: e instanceof Error ? e.message : "Preview failed",
      };
    } finally {
      done++;
      onProgress?.(done, files.length);
    }
  });
}

// -- Storage quota (the 10-users-x-10-files crash guard) ----------------------

export interface WorkspaceUsage {
  usedBytes: number;
  truncated: boolean;
}

/** Sum of stored file sizes for the workspace. Bounded (QUOTA_LOOKUP_LIMIT);
 *  `truncated` flags an approximate answer on huge libraries. */
export async function readWorkspaceUsage(): Promise<WorkspaceUsage> {
  const sb = createClient();
  const ws = await getWorkspaceId();
  const { data, error } = await sb
    .from("documents")
    .select("file_size")
    .eq("workspace_id", ws)
    .limit(QUOTA_LOOKUP_LIMIT);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ file_size: number | null }>;
  return {
    usedBytes: rows.reduce((sum, r) => sum + (r.file_size ?? 0), 0),
    truncated: rows.length >= QUOTA_LOOKUP_LIMIT,
  };
}

export interface QuotaAssessment {
  ok: boolean;
  usedBytes: number;
  batchBytes: number;
  quotaBytes: number;
  message: string | null;
}

/** Pure: does this batch fit the remaining quota? */
export function assessQuota(
  usedBytes: number,
  batchBytes: number,
  quotaBytes: number = WORKSPACE_STORAGE_QUOTA_BYTES,
): QuotaAssessment {
  if (usedBytes + batchBytes > quotaBytes) {
    const remainingMB = Math.max(0, (quotaBytes - usedBytes) / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      usedBytes,
      batchBytes,
      quotaBytes,
      message:
        `Batch too large for workspace storage: ${(batchBytes / 1024 / 1024).toFixed(1)} MB ` +
        `incoming, ${remainingMB} MB free of ${(quotaBytes / 1024 / 1024).toFixed(0)} MB. ` +
        `Remove files or ask an admin to free space.`,
    };
  }
  return { ok: true, usedBytes, batchBytes, quotaBytes, message: null };
}

/**
 * Confirm + index every item serially (document concurrency 1 — see module
 * header). Each item flows through executeIngestFlow, so year validation,
 * DOI cleaning, and confirm assembly are exactly the single-upload rules.
 * Per-item failures are collected; the batch always runs to completion.
 * Exactly one logEvent per batch (operation facts only, never titles/text).
 */
export async function confirmBulkFiles(
  items: readonly BulkConfirmItem[],
  opts: {
    embedMode: "local" | "server";
    confirmFn?: (input: ConfirmInput) => Promise<{
      document: ConfirmedDocument;
      indexingError: string | null;
    }>;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<BulkConfirmSummary> {
  assertBatchSize(items as unknown as readonly File[]);
  const confirm = opts.confirmFn ?? confirmIngest;
  const started = Date.now();
  const results: BulkConfirmResult[] = [];
  let done = 0;
  // Serial on purpose: bounded peak embed concurrency (4, inside confirm),
  // one storage upload at a time, failures isolated per document.
  for (const item of items) {
    const outcome: BulkConfirmResult = {
      fileName: item.file.name,
      document: null,
      indexing_error: null,
      error: null,
    };
    await executeIngestFlow(
      confirm,
      {
        file: item.file,
        preview: item.preview,
        edit: item.edit,
        candidate: item.candidate,
        embedMode: opts.embedMode,
      },
      {
        phase: () => {},
        done: (r) => {
          outcome.document = r.document;
          outcome.indexing_error = r.indexing_error;
        },
        failed: (message) => {
          outcome.error = message;
        },
      },
    );
    results.push(outcome);
    done++;
    opts.onProgress?.(done, items.length);
  }
  const succeeded = results.filter((r) => r.document && !r.error).length;
  const failed = results.length - succeeded;
  logEvent(failed === 0 ? "info" : "warn", "ingest.bulk_confirm", {
    files: items.length,
    succeeded,
    failed,
    embedMode: opts.embedMode,
    batchBytes: items.reduce((sum, i) => sum + (i.file.size ?? 0), 0),
    durationMs: Date.now() - started,
    ok: failed === 0,
    // Coarse failure class for dashboards; per-file reasons stay in the
    // returned summary (shown inline in the UI), never in the log.
    ...(failed === 0 ? {} : { errorCategory: errorCategory("bulk item failed") }),
  });
  return { results, succeeded, failed };
}
