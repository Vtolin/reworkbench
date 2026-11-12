// Browser ingestion pipeline: preview (deterministic analysis, no upload) +
// confirm (Storage upload → rows → embeddings → pending approval).
// Preserves the UploadFlow "AI proposes, human confirms" contract.
import { createClient } from "@/lib/supabase/client";
import { checkDuplicates } from "@/lib/ingestion/dedup";
import { suggestCollection } from "@/lib/ingestion/classify";
import { analyzeFileOffThread, chunkTextOffThread } from "@/lib/ingestion/offThread";
import { embedSlice } from "@/lib/ingestion/embed";
import { pageOneText } from "@/lib/ingestion/analyze";
import { fetchMetadata } from "./openalex";
import { getWorkspaceId, listCollections } from "./library";
import { chunkArray, mapWithLimit } from "@/lib/async/pool";
import { errorCategory, logEvent } from "@/lib/observability/log";
import { ensureAuthorIds } from "./taxonomy";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { CloudProviderId } from "@/lib/ai/cloud";
import type { ChatMessage } from "@/lib/ai/types";

// Public surface preserved: pure analysis + embedding now live in focused
// modules (shared with the ingest Web Worker), re-exported here so existing
// imports keep working.
export { extractTitleCandidate, extractYear, pageOneText, extractIsbn, extractPmid } from "@/lib/ingestion/analyze";
export { embedSlice } from "@/lib/ingestion/embed";
export type { EmbeddedSlice, EmbedMode } from "@/lib/ingestion/embed";


export interface IngestPreview {
  filename: string;
  fileHash: string;
  fileSize: number;
  mimeType: string;
  pageCount: number | null;
  text: string;
  textSnippet: string;
  extracted: {
    title: string;
    year: number | null;
    doi: string | null;
    jurisdiction: string | null;
    document_type: string;
  };
  metadataProposal: import("./openalex").MetadataCandidate;
  metadataCandidates: import("./openalex").MetadataCandidate[];
  metadataError: string | null;
  offline: boolean;
  duplicates: Array<{ id: string; title: string; label: string; confidence: number }>;
  isDuplicate: boolean;
  /** True when no extractable text was found (e.g. scanned-image PDF). */
  noText: boolean;
  /** Extraction threw instead of returning empty (worker/parse failure). */
  extractionError: string | null;
  suggestedCollection: { id: string; name: string } | null;
  collectionReason: string;
  collectionConfidence: number;
  decision: string;
}

// ---------------------------------------------------------------------------
// On-demand LLM metadata assist (page-1 skim). NOT run automatically:
// one upload-time call is cheap, but automatic calls would still burn
// quota for every dropped file, so the UI only calls this when the user
// clicks "Suggest from page 1" (typically when OpenAlex found nothing).
// ---------------------------------------------------------------------------

export interface TitleAssist {
  title: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
}

export function buildTitleAssistPrompt(pageOne: string): string {
  return (
    `You are a metadata-extraction function. From the first-page text below, extract ` +
    `bibliographic metadata. Return JSON only: ` +
    `{"title": "...", "authors": ["..."], "year": 2024, "venue": "...", "doi": "..."}.\n\n` +
    `Rules:\n` +
    `- "title" is the DOCUMENT's own title (paper/chapter/thesis title), NOT the ` +
    `book, journal, series, or working-paper name printed above/below it.\n` +
    `- "authors" are person names listed as authors only (never venues, labs, courses).\n` +
    `- "year" is the publication year only if printed on the page, else null.\n` +
    `- "venue" is the journal/conference/book/series name if printed, else null.\n` +
    `- "doi" is the DOI string if printed, else null.\n` +
    `- Never invent values. Use null (or [] for authors) when absent.\n\n` +
    `First page:\n${pageOne.slice(0, 3000)}`
  );
}

function stripAssistFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export function parseTitleAssistJson(text: string): TitleAssist {
  const cleaned = stripAssistFences(text);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Assist model did not return JSON");
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  }
  const yearRaw = obj.year;
  const year =
    typeof yearRaw === "number" && Number.isInteger(yearRaw) && yearRaw >= 1900 && yearRaw <= 2100
      ? yearRaw
      : null;
  return {
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 300) : null,
    authors: Array.isArray(obj.authors)
      ? (obj.authors as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : [],
    year,
    venue: typeof obj.venue === "string" && obj.venue.trim() ? obj.venue.trim().slice(0, 300) : null,
    doi: typeof obj.doi === "string" && obj.doi.trim() ? obj.doi.trim().toLowerCase() : null,
  };
}

/** Minimal model selection for the page-1 metadata skim (subset of device
 *  settings; intentionally local — lib must not import UI context types). */
export interface SuggestSelection {
  provider: "ollama" | "cloud";
  model: string;
  cloudProvider: CloudProviderId;
  cloudModel: string;
  numCtx: number;
}

/**
 * On-demand page-1 metadata skim: one small temperature-0 LLM call.
 * Moved from UploadFlow (Phase 8) so page components no longer instantiate
 * AI providers directly; orchestration unchanged, state stays in the UI.
 */
export async function suggestMetadata(pageText: string, sel: SuggestSelection): Promise<TitleAssist> {
  const prompt = buildTitleAssistPrompt(pageOneText(pageText ?? ""));
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a metadata-extraction function. Output ONLY the requested JSON." },
    { role: "user", content: prompt },
  ];
  const stripThinking = (content: string): string =>
    content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (sel.provider === "ollama") {
    const r = await new OllamaProvider().chat(
      messages,
      { model: sel.model, temperature: 0, numCtx: sel.numCtx, numPredict: 512 },
    );
    return parseTitleAssistJson(stripThinking(r.content ?? ""));
  }
  const r = await new CloudProvider(sel.cloudProvider).chat(
    messages,
    { model: sel.cloudModel, temperature: 0, numCtx: sel.numCtx, numPredict: 512 },
  );
  return parseTitleAssistJson(stripThinking(r.content ?? ""));
}

// Supabase free tier ships ~1GB of storage: cap single uploads so one file
// (or a modified client ignoring the UI) can't fill the bucket. Matches the
// old backend's 150 MB cap.
export const MAX_FILE_BYTES = 150 * 1024 * 1024;

function assertFileSize(file: File): void {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  }
}

export async function previewFile(file: File): Promise<IngestPreview> {
  assertFileSize(file);
  // Extraction, hashing and text analysis run in the ingest Web Worker when
  // available (main-thread fallback otherwise), so large PDFs/XLSX never
  // freeze the UI. Extraction failures are RETURNED, never swallowed: a
  // silent empty string becomes a 0-chunk "metadata_only" row that looks
  // like a scanned PDF but isn't.
  const { fileHash, text, pageCount, extractionError, analysis } =
    await analyzeFileOffThread(file);
  const { title, year, doi, isbn, pmid, documentType: docType, textSnippet } = analysis;

  const sb = createClient();
  const ws = await getWorkspaceId();
  const [{ data: existing }, collections] = await Promise.all([
    // Bounded duplicate-detection window (2000 newest): exact hash/doi hits
    // are order-independent, but title-fuzzy matching needs a deterministic
    // candidate set — newest-first, not whatever the database returns.
    sb.from("documents").select("id, title, file_hash, doi, year").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(2000),
    listCollections().catch(() => [] as Array<{ id: string; name: string }>),
  ]);
  const dupHits = checkDuplicates(
    { file_hash: fileHash, doi, title, authors: [], year },
    ((existing ?? []) as Array<{ id: string; title?: string | null; file_hash?: string | null; doi?: string | null; year?: number | null }>).map((d) => ({
      id: d.id,
      title: d.title,
      file_hash: d.file_hash,
      doi: d.doi,
      year: d.year,
    })),
  );

  let proposal, candidates: IngestPreview["metadataCandidates"], metadataError: string | null, offline: boolean;
  try {
    const r = await fetchMetadata({
      doi,
      isbn,
      pmid,
      title,
      authors: [],
      localFields: { title, authors: [], year, doi, journal: null, document_type: docType, jurisdiction: null },
    });
    proposal = r.proposal;
    candidates = r.candidates;
    metadataError = r.error;
    offline = r.offline;
  } catch (e) {
    proposal = {
      source: "local", title, authors: [], year, doi, journal: null, volume: null, issue: null,
      pages: null, publisher: null, abstract: null, document_type: docType, confidence: 0.45, extras: {},
    };
    candidates = [];
    metadataError = e instanceof Error ? e.message : "Metadata lookup failed";
    offline = true;
  }

  const sugg = suggestCollection(docType, null, year, collections);
  const hasHashDup = dupHits.some((d) => d.reason === "hash");
  return {
    filename: file.name,
    fileHash,
    fileSize: file.size,
    mimeType: file.type,
    pageCount,
    text,
    textSnippet,
    extracted: { title, year, doi, jurisdiction: null, document_type: docType },
    metadataProposal: proposal,
    metadataCandidates: candidates,
    metadataError,
    offline,
    duplicates: dupHits.map((d) => ({
      id: d.document.id,
      title: (d.document.title as string) ?? "(untitled)",
      label: d.label,
      confidence: d.confidence,
    })),
    isDuplicate: hasHashDup,
    noText: text.trim().length === 0,
    extractionError,
    suggestedCollection: sugg.collection,
    collectionReason: sugg.reason,
    collectionConfidence: sugg.confidence,
    decision: hasHashDup ? "duplicate" : sugg.confidence >= 0.6 ? "auto_suggest" : "confirm",
  };
}

export interface ConfirmInput {
  file: File;
  preview: IngestPreview;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  journal: string | null;
  jurisdiction: string | null;
  document_type: string | null;
  abstract: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  citationMetadata: Record<string, unknown>;
  metadataSource: string;
  metadataConfidence: number | null;
  collectionIds: string[];
  embedMode: "local" | "server";
}

export interface ConfirmedDocument {
  id: string;
  title: string;
  stored_path: string;
  ingestion_status: string;
  metadata_source: string;
  metadata_confidence: number | null;
}

export async function confirmIngest(input: ConfirmInput): Promise<{
  document: ConfirmedDocument;
  indexingError: string | null;
}> {
  const { file, preview } = input;
  assertFileSize(file);
  // Operation facts only (Task O): stage counts, mode, outcome — never file
  // names, titles, or text (user content stays out of the logs).
  const started = Date.now();
  const sb = createClient();
  const ws = await getWorkspaceId();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");

  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "bin";
  const storagePath = `${ws}/${preview.fileHash}.${ext}`;
  const { error: upErr } = await sb.storage.from("documents").upload(storagePath, file, {
    upsert: true,
    contentType: file.type || "application/octet-stream",
  });
  if (upErr) throw new Error(upErr.message);

  // Page-aware: PDF markers become chunk.page ("h. X" citations) and are
  // stripped from stored content. Non-PDF texts behave like chunkText.
  // Chunking runs in the ingest worker (direct fallback) so long books do
  // not block the UI thread.
  const chunks = await chunkTextOffThread(preview.text);
  const { data: doc, error: docErr } = await sb
    .from("documents")
    .insert({
      workspace_id: ws,
      title: input.title || preview.extracted.title,
      original_filename: file.name,
      storage_path: storagePath,
      file_hash: preview.fileHash,
      file_size: file.size,
      mime_type: file.type,
      doi: input.doi,
      year: input.year,
      journal: input.journal,
      volume: input.volume,
      issue: input.issue,
      pages: input.pages,
      publisher: input.publisher,
      abstract: input.abstract,
      jurisdiction: input.jurisdiction,
      document_type: input.document_type ?? preview.extracted.document_type,
      page_count: preview.pageCount,
      ingestion_status: chunks.length ? "ready" : "metadata_only",
      metadata_json: { text_snippet: preview.textSnippet },
      citation_metadata: input.citationMetadata,
      metadata_source: input.metadataSource,
      metadata_confidence: input.metadataConfidence,
      metadata_verified: true,
      status: "pending",
      uploaded_by: me.user.id,
    })
    .select("id, title")
    .single();
  if (docErr || !doc) {
    // No row exists, so the just-uploaded object would be an orphan: remove
    // it best-effort (logged) so failed confirms leave no storage garbage.
    // When the row DOES exist, later failures keep it and mark
    // ingestion_status=error instead — visible and recoverable, never silent.
    const { error: rmErr } = await sb.storage.from("documents").remove([storagePath]);
    logEvent(rmErr ? "warn" : "info", "ingest.confirm.cleanup", {
      fileBytes: file.size,
      ok: !rmErr,
      ...(rmErr ? { errorCategory: errorCategory(rmErr.message) } : {}),
    });
    throw new Error(docErr?.message ?? "Document insert failed");
  }
  const docId = (doc as { id: string }).id;

  // Authors + collections (workspace-scoped upserts). Link failures are
  // collected (not thrown): the document row is the source of truth, but
  // the caller must surface what didn't attach.
  const linkErrors: string[] = [];
  if (input.authors.length) {
    // Set-based author resolution (one SELECT + one bulk INSERT) + one bulk
    // link INSERT. Same outcome as the old per-author loop; link failures are
    // still collected, not thrown: the document row is the source of truth.
    const trimmed = input.authors.map((a) => a.trim()).filter(Boolean);
    const resolved = await ensureAuthorIds(sb, ws, trimmed);
    const links: Array<{ document_id: string; author_id: string; author_order: number }> = [];
    const seen = new Set<string>();
    resolved.forEach((r, i) => {
      const name = trimmed[i];
      if (r.error) linkErrors.push(`author "${name}": ${r.error}`);
      if (r.id && !seen.has(r.id)) {
        seen.add(r.id);
        links.push({ document_id: docId, author_id: r.id, author_order: links.length });
      } else if (!r.id && !linkErrors.some((m) => m.includes(`"${name}"`))) {
        linkErrors.push(`author "${name}": unresolved`);
      }
    });
    if (links.length) {
      const { error: linkErr } = await sb.from("document_authors").insert(links);
      if (linkErr) linkErrors.push(`author links: ${linkErr.message}`);
    }
  }
  if (input.collectionIds.length) {
    const { error: colErr } = await sb.from("document_collections").insert(
      input.collectionIds.map((collection_id) => ({ document_id: docId, collection_id })),
    );
    if (colErr) linkErrors.push(`collections: ${colErr.message}`);
  }
  // First-class bibliographic source row.
  {
    const { error: srcErr } = await sb.from("sources").insert({
      workspace_id: ws,
      document_id: docId,
      source_type: "journal",
      doi: input.doi,
      title: input.title,
      journal: input.journal,
      volume: input.volume,
      issue: input.issue,
      pages: input.pages,
      publisher: input.publisher,
      year: input.year,
      authors_json: input.authors,
    });
    if (srcErr) linkErrors.push(`sources row: ${srcErr.message}`);
  }

  let indexingError: string | null = linkErrors.length ? `metadata links incomplete — ${linkErrors.join("; ").slice(0, 500)}` : null;
  if (chunks.length) {
    try {
      const { data: rows, error: chunkErr } = await sb
        .from("document_chunks")
        .insert(
          chunks.map((c) => ({
            workspace_id: ws,
            document_id: docId,
            content: c.content,
            chunk_index: c.chunk_index,
            page: c.page ?? null,
            section: c.section ?? null,
          }))
        )
        .select("id, content");
      if (chunkErr) throw new Error(chunkErr.message);
      const chunkRows = (rows ?? []) as Array<{ id: string; content: string }>;
      // Bounded parallelism (4): Ollama serializes locally and server egress
      // is shared — never Promise.all over an unbounded chunk list. Order is
      // irrelevant (chunk_index is stored explicitly); the first failure
      // still aborts the rest and marks the document errored, as before.
      // Embeddings are collected first and persisted with ONE bulk insert:
      // N per-chunk round trips become 1, and a mid-pipeline failure can no
      // longer leave a document half-embedded (orphaned rows the old code
      // left behind when chunk k failed after chunks 0..k-1 were stored).
      const embedRows = await mapWithLimit(chunkRows, 4, async (row) => ({
        chunk_id: row.id,
        ...(await embedSlice(row.content, input.embedMode)),
      }));
      if (embedRows.length) {
        const { error: embErr } = await sb.from("document_embeddings").insert(embedRows);
        if (embErr) throw new Error(embErr.message);
      }
    } catch (e) {
      const embedErr = e instanceof Error ? e.message : "Embedding failed";
      indexingError = indexingError ? `${indexingError} | embedding: ${embedErr}` : embedErr;
      await sb.from("documents").update({ ingestion_status: "error", ingestion_error: indexingError }).eq("id", docId);
    }
  }
  // Link-only failures (authors/collections/sources above) never threw, so
  // the row still says ready/metadata_only. Persist the reason too: an
  // errored document must be visible in the Admin queue however it failed.
  if (indexingError) {
    const { data: cur } = await sb.from("documents").select("ingestion_status").eq("id", docId).maybeSingle();
    if (cur && (cur as { ingestion_status: string }).ingestion_status !== "error") {
      await sb.from("documents").update({ ingestion_status: "error", ingestion_error: indexingError }).eq("id", docId);
    }
  }

  const { data: fresh } = await sb
    .from("documents")
    .select("id, title, storage_path, ingestion_status, metadata_source, metadata_confidence")
    .eq("id", docId)
    .single();
  logEvent(indexingError ? "warn" : "info", "ingest.confirm", {
    docId,
    chunks: chunks.length,
    embedMode: input.embedMode,
    fileBytes: file.size,
    durationMs: Date.now() - started,
    ok: !indexingError,
    ...(indexingError ? { errorCategory: errorCategory(indexingError) } : {}),
  });
  return {
    document: fresh as unknown as ConfirmedDocument,
    indexingError,
  };
}

// -- Recovery (Phase 4, admin-triggered) ------------------------------------
// All helpers are idempotent: re-running them after a partial recovery is a
// no-op for already-healthy rows.

export interface IngestHealthRow {
  document_id: string;
  title: string;
  ingestion_status: string;
  ingestion_error: string | null;
  chunks: number;
  embedded: number;
}

/** Admin ingest-health snapshot (migration 0013). One RPC, never polled. */
export async function fetchIngestHealth(): Promise<IngestHealthRow[]> {
  const ws = await getWorkspaceId();
  const { data, error } = await createClient().rpc("ingest_health", { ws_id: ws });
  if (error) throw new Error(error.message);
  return ((data ?? []) as IngestHealthRow[]).map((r) => ({
    ...r,
    chunks: Number(r.chunks),
    embedded: Number(r.embedded),
  }));
}

/** Chunk ids minus already-embedded ids. Pure (unit-tested). */
export function computeMissingEmbeddings(
  chunkIds: string[],
  embeddedChunkIds: Array<string | null>,
): string[] {
  const have = new Set(embeddedChunkIds.filter((id): id is string => !!id));
  return chunkIds.filter((id) => !have.has(id));
}

export interface ReembedSummary {
  docsScanned: number;
  docsFixed: number;
  chunksEmbedded: number;
  chunksSkipped: number;
  warnings: string[];
}

/**
 * Idempotent re-embed of chunks missing vectors (admin-triggered).
 * Embeds with bounded parallelism (4), skips chunks that already have
 * embeddings, bulk-inserts per document, and flips error→ready only when the
 * document is fully covered. A failed status flip is a warning, never a
 * rollback: the vectors already landed, so the document is no longer
 * FTS-only either way.
 */
export async function reembedMissingEmbeddings(opts: {
  embedMode: "local" | "server";
  docIds?: string[];
  onProgress?: (done: number, total: number) => void;
}): Promise<ReembedSummary> {
  const sb = createClient();
  const ws = await getWorkspaceId();
  const summary: ReembedSummary = {
    docsScanned: 0,
    docsFixed: 0,
    chunksEmbedded: 0,
    chunksSkipped: 0,
    warnings: [],
  };
  const started = Date.now();
  let targets: IngestHealthRow[];
  if (opts.docIds) {
    const { data, error } = await sb
      .from("documents")
      .select("id, title, ingestion_status, ingestion_error")
      .eq("workspace_id", ws)
      .in("id", opts.docIds);
    if (error) throw new Error(error.message);
    targets = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      document_id: r.id as string,
      title: (r.title as string) ?? "(untitled)",
      ingestion_status: (r.ingestion_status as string) ?? "",
      ingestion_error: (r.ingestion_error as string | null) ?? null,
      chunks: 0,
      embedded: 0,
    }));
  } else {
    const { data, error } = await sb.rpc("ingest_health", { ws_id: ws });
    if (error) throw new Error(error.message);
    targets = (data ?? []) as IngestHealthRow[];
  }
  summary.docsScanned = targets.length;
  let done = 0;
  for (const target of targets) {
    done++;
    opts.onProgress?.(done, targets.length);
    const { data: chunkRows, error: chunkErr } = await sb
      .from("document_chunks")
      .select("id, content")
      .eq("workspace_id", ws)
      .eq("document_id", target.document_id)
      .order("chunk_index");
    if (chunkErr) {
      summary.warnings.push(`${target.title}: chunks unreadable (${chunkErr.message})`);
      continue;
    }
    const chunks = (chunkRows ?? []) as Array<{ id: string; content: string }>;
    if (!chunks.length) {
      summary.warnings.push(`${target.title}: no chunks stored — re-upload required`);
      continue;
    }
    const ids = chunks.map((c) => c.id);
    let embeddedIds: string[] = [];
    for (const batch of chunkArray(ids)) {
      const { data: embRows, error: embErr } = await sb
        .from("document_embeddings")
        .select("chunk_id")
        .in("chunk_id", batch);
      if (embErr) {
        summary.warnings.push(`${target.title}: embeddings unreadable (${embErr.message})`);
        embeddedIds = [];
        break;
      }
      embeddedIds.push(...((embRows ?? []) as Array<{ chunk_id: string }>).map((r) => r.chunk_id));
    }
    const missing = computeMissingEmbeddings(ids, embeddedIds);
    summary.chunksSkipped += ids.length - missing.length;
    if (!missing.length) continue;
    const byId = new Map(chunks.map((c) => [c.id, c.content]));
    let embedRows: Array<{ chunk_id: string; embedding: number[]; model_name: string }>;
    try {
      embedRows = await mapWithLimit(missing, 4, async (chunkId) => ({
        chunk_id: chunkId,
        ...(await embedSlice(byId.get(chunkId) ?? "", opts.embedMode)),
      }));
    } catch (e) {
      summary.warnings.push(`${target.title}: embed failed (${e instanceof Error ? e.message : "unknown"})`);
      continue;
    }
    const { error: insErr } = await sb.from("document_embeddings").insert(embedRows);
    if (insErr) {
      summary.warnings.push(`${target.title}: embeddings not stored (${insErr.message})`);
      continue;
    }
    summary.chunksEmbedded += embedRows.length;
    summary.docsFixed++;
    if (target.ingestion_status === "error") {
      const { error: flipErr } = await sb
        .from("documents")
        .update({ ingestion_status: "ready", ingestion_error: null })
        .eq("id", target.document_id);
      if (flipErr) summary.warnings.push(`${target.title}: vectors stored but status flip blocked (${flipErr.message})`);
    }
  }
  logEvent(summary.warnings.length ? "warn" : "info", "ingest.reembed", {
    docsScanned: summary.docsScanned,
    docsFixed: summary.docsFixed,
    chunksEmbedded: summary.chunksEmbedded,
    chunksSkipped: summary.chunksSkipped,
    warnings: summary.warnings.length,
    durationMs: Date.now() - started,
    ok: summary.warnings.length === 0,
  });
  return summary;
}

// -- Orphan sweep (Phase 4, admin-triggered) ---------------------------------

export interface OrphanScan {
  orphans: string[];
  truncated: boolean;
}

/**
 * Storage objects under the workspace prefix with no documents row.
 * Bounded (default 1000): truncated flags an approximate answer on huge
 * buckets. Never deletes — see sweepOrphanStorage for the explicit action.
 */
export async function listOrphanStoragePaths(limit = 1000): Promise<OrphanScan> {
  const sb = createClient();
  const ws = await getWorkspaceId();
  const { data: objects, error: listErr } = await sb.storage.from("documents").list(ws, { limit, offset: 0 });
  if (listErr) throw new Error(listErr.message);
  const names = ((objects ?? []) as Array<{ name: string }>).map((o) => o.name).filter(Boolean);
  const { data: rows, error: docErr } = await sb
    .from("documents")
    .select("storage_path")
    .eq("workspace_id", ws)
    .limit(limit);
  if (docErr) throw new Error(docErr.message);
  const live = new Set(
    ((rows ?? []) as Array<{ storage_path: string | null }>).map((r) => r.storage_path).filter((p): p is string => !!p),
  );
  return {
    orphans: names.map((n) => `${ws}/${n}`).filter((p) => !live.has(p)),
    truncated: names.length >= limit,
  };
}

export interface OrphanSweep {
  removed: string[];
  errors: string[];
}

/** Delete confirmed orphans (admin action). Batched; per-batch results. */
export async function sweepOrphanStorage(paths: string[]): Promise<OrphanSweep> {
  const sb = createClient();
  const out: OrphanSweep = { removed: [], errors: [] };
  const started = Date.now();
  for (const batch of chunkArray(paths, 100)) {
    const { data, error } = await sb.storage.from("documents").remove(batch);
    if (error) {
      out.errors.push(error.message);
      continue;
    }
    out.removed.push(...((data ?? []) as Array<{ path?: string; name?: string }>).map((r) => r.path ?? r.name ?? ""));
  }
  logEvent(out.errors.length ? "warn" : "info", "ingest.sweep_orphans", {
    removed: out.removed.length,
    errors: out.errors.length,
    durationMs: Date.now() - started,
    ok: out.errors.length === 0,
  });
  return out;
}
