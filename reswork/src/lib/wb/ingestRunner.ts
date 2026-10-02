import { toUserMessage } from "@/lib/errors";
import { cleanDoi } from "./openalex";
import type { ConfirmedDocument, ConfirmInput, IngestPreview } from "./ingest";

// Ingest-flow runner (Phase 6): the UploadFlow confirm core as a UI-free,
// injectable orchestrator. UploadFlow itself is intentionally unwired (rule:
// no UploadFlow changes beyond typing) — this runner is tested here and
// ready to adopt. Year validation and confirm assembly mirror UploadFlow
// exactly; confirmIngest (lib/wb/ingest) is untouched.

export interface IngestRunnerEdit {
  title: string;
  authors: string;
  year: string | number;
  doi: string;
  journal: string | null;
  jurisdiction: string | null;
  document_type: string | null;
  abstract: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  collection_ids: string[];
}

export interface IngestCandidate {
  source: string;
  confidence?: number | null;
  extras?: Record<string, unknown>;
}

export type ValidateYear =
  | { ok: true; year: number | null }
  | { ok: false; error: string };

/**
 * Human-editable year validation (verbatim UploadFlow rule): raw
 * Number("…")/DOI strings would otherwise store NaN years and punctuated
 * DOIs that break later dedup.
 */
export function validateUploadYear(raw: string | number | null | undefined): ValidateYear {
  const rawYear = String(raw ?? "").trim();
  const yearNum = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  if (rawYear && (!Number.isInteger(yearNum) || yearNum < 1000 || yearNum > 2100)) {
    return { ok: false, error: `Invalid year "${rawYear}" — use a 4-digit year 1000–2100 or leave it empty.` };
  }
  return { ok: true, year: rawYear ? yearNum : null };
}

export interface IngestRunResult {
  document: ConfirmedDocument;
  indexing_error: string | null;
}

export interface IngestRunnerEvents {
  phase: (text: string) => void;
  done: (result: IngestRunResult) => void;
  failed: (message: string) => void;
}

export async function executeIngestFlow(
  confirm: (input: ConfirmInput) => Promise<{ document: ConfirmedDocument; indexingError: string | null }>,
  input: {
    file: File;
    preview: IngestPreview;
    edit: IngestRunnerEdit;
    candidate: IngestCandidate | null;
    embedMode: "local" | "server";
  },
  events: IngestRunnerEvents,
): Promise<void> {
  events.phase("Uploading → creating record → embedding chunks…");
  const checked = validateUploadYear(input.edit.year);
  if (!checked.ok) {
    events.phase("");
    events.failed(checked.error);
    return;
  }
  try {
    const r = await confirm({
      file: input.file,
      preview: input.preview,
      title: input.edit.title,
      authors: (input.edit.authors || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      year: checked.year,
      doi: cleanDoi(input.edit.doi) || null,
      journal: input.edit.journal || null,
      jurisdiction: input.edit.jurisdiction || null,
      document_type: input.edit.document_type || null,
      abstract: input.edit.abstract || null,
      volume: input.edit.volume || null,
      issue: input.edit.issue || null,
      pages: input.edit.pages || null,
      publisher: input.edit.publisher || null,
      citationMetadata: input.candidate?.extras || {},
      metadataSource: input.candidate?.source || "local",
      metadataConfidence: input.candidate ? (input.candidate.confidence ?? null) : null,
      collectionIds: input.edit.collection_ids || [],
      embedMode: input.embedMode,
    });
    events.done({ document: { ...r.document, id: r.document.id }, indexing_error: r.indexingError });
  } catch (e) {
    events.failed(toUserMessage(e));
  } finally {
    events.phase("");
  }
}
