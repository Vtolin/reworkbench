// Browser ingestion pipeline: preview (deterministic analysis, no upload) +
// confirm (Storage upload → rows → embeddings → pending approval).
// Preserves the UploadFlow "AI proposes, human confirms" contract.
import { createClient } from "@/lib/supabase/client";
import { sha256Hex, chunkTextWithPages } from "@/lib/ingestion/chunking";
import { extractDocumentText } from "@/lib/importing/docloaders";
import { checkDuplicates, extractDoi } from "@/lib/ingestion/dedup";
import { classifyDocumentType, suggestCollection } from "@/lib/ingestion/classify";
import { fetchMetadata } from "./openalex";
import { getWorkspaceId, listCollections } from "./library";
import { chunkArray, mapWithLimit } from "@/lib/async/pool";
import { errorCategory, logEvent } from "@/lib/observability/log";
import { ensureAuthorIds } from "./taxonomy";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { CloudProviderId } from "@/lib/ai/cloud";
import type { ChatMessage } from "@/lib/ai/types";

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

/** Lines that look like venue/cover labels rather than the document's own title.
 *  Generic shape patterns only — no topic or field keywords. */
const TITLE_JUNK_RE =
  /^(working papers?( \d| no\.| are)?|degree project|course code|findings of|draft (of|version)|copyright|all rights reserved|authors?(\s*[:–-])?|supervisor|examiner|subject|level|department of|school of|faculty of|chapter \d+|figure \d+|table \d+|contents|daftar isi|abstrak$|abstract$|keywords?\s*[:–-]|kata kunci\s*[:–-])/i;
const VENUE_HINT_RE = /(proceedings|findings of|journal of|working paper|chapter \d+|degree project|technical report|conference on|transactions on)/i;
/** Cover-label prefixes fused onto the title line ("Degree Project <title>"). */
const PREFIX_STRIP_RE =
  /^(?:degree project|working papers?(?: no\.? [\w-]+)?|findings of [^:]{2,80}:|draft of [^:]{2,80}:?)\s+/i;
/** Publisher boilerplate that out-longs real titles (no topic keywords). */
const BOILERPLATE_RE =
  /(draft form|distributed for purposes|without permission|all rights reserved|may not be reproduced|copies of .* available|grateful to|research assistance|funding for this research|previously circulated|do not cite|preliminary version)/i;
/** Lowercase particles that don't disqualify an author-name line. */
const NAME_PARTICLES_RE = /\b(de|van|von|der|bin|al|del|da|di|le|la)\b/gi;
/** "CHAPTER 7 Large Language Models" / "BAB 2 …" → group 1 is the real title. */
const CHAPTER_TITLE_RE = /^(?:chapter|bab)\s+\d+\s*[:–.-]?\s*(.{10,200})$/im;

function cleanPageMarkers(text: string): string {
  return (text ?? "").replace(/\[Page \d+\]\n?/g, " ");
}

function isEmailLine(s: string): boolean {
  return s.includes("@");
}

function isMostlyNumeric(s: string): boolean {
  const alnum = s.replace(/[^A-Za-z0-9]/g, "");
  if (!alnum) return true;
  const digits = (s.match(/\d/g) ?? []).length;
  return digits / Math.max(s.length, 1) > 0.4;
}

/**
 * Extract the document's own title from head-of-document text.
 * Strategy (generic, no topic lists):
 *  1. A "Chapter N <title>" line wins outright (edited volumes: the chapter
 *     title is the document, the book name is not).
 *  2. Else look at the block before "Abstract", skip cover/venue/boilerplate
 *     lines and author-name blobs, then take the longest substantial line,
 *     joining one wrapped continuation line.
 * Falls back to the first non-empty line, then the filename.
 */
export function extractTitleCandidate(text: string, filename: string): { title: string; method: string } {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
  const clean = cleanPageMarkers(text);
  const head = clean.slice(0, 4000);
  const chapterM = head.match(CHAPTER_TITLE_RE);
  if (chapterM) return { title: chapterM[1].trim().slice(0, 250), method: "chapter" };
  const absIdx = head.search(/\babstract\b/i);
  const scope = absIdx > 0 ? head.slice(0, absIdx) : head;
  const rawLines = scope.split("\n").map((l) => l.trim().replace(/\s+/g, " "));
  const stripped = rawLines.map((l) => l.replace(PREFIX_STRIP_RE, "").trim());
  const isNameBlob = (l: string): boolean => {
    // Person-name / affiliation lines: short, all-capitalized words, no
    // title paraphernalia (parens, digits, function words). Fully Title-Cased
    // paper titles without any lowercase word are a rare casualty here —
    // the on-demand page-1 assist covers them.
    if (/[()0-9]/.test(l) || l.length > 60) return false;
    const words = l.replace(NAME_PARTICLES_RE, "").split(/\s+/).filter(Boolean);
    return (
      words.length >= 2 && words.every((w) => /^[A-ZÀ-Þ][\w'’.,()-]*$/.test(w))
    );
  };
  const commaCount = (l: string): number => (l.match(/,/g) ?? []).length;
  /** Affiliation footnote markers fused onto the line ("g SDAIA-KFUPM …"). */
  const hasMarkerPrefix = (l: string): boolean => /^[a-z] [A-Z]/.test(l);
  const lines = stripped
    .filter((l) => l.length >= 12 && l.length <= 300)
    .filter(
      (l) =>
        !isEmailLine(l) && !isMostlyNumeric(l) && !TITLE_JUNK_RE.test(l) &&
        !BOILERPLATE_RE.test(l) && !isNameBlob(l) && !hasMarkerPrefix(l) &&
        commaCount(l) < 2,
    );
  // Prefer lines that do NOT look like venue/series names.
  const own = lines.filter((l) => !VENUE_HINT_RE.test(l));
  const pool = own.length ? own : lines;
  if (pool.length) {
    let best = pool[0];
    for (const l of pool) if (l.length > best.length) best = l;
    const rawIdx = stripped.indexOf(best);
    const looksTitleish = (s: string): boolean =>
      !!s && s.length >= 3 && s.length <= 300 && !isEmailLine(s) && !isMostlyNumeric(s) &&
      !TITLE_JUNK_RE.test(s) && !BOILERPLATE_RE.test(s) && !isNameBlob(s) &&
      !hasMarkerPrefix(s) && !VENUE_HINT_RE.test(s) && commaCount(s) < 2;
    // A wrapped title head that fell below the pool's 12-char floor (e.g.
    // "Research") is still joinable — length floor doesn't apply here.
    const looksContinuation = (s: string): boolean =>
      !!s && s.length >= 3 && s.length <= 60 && /^[A-Z0-9(]/.test(s) && !/[.!?]$/.test(s) &&
      !isEmailLine(s) && !isMostlyNumeric(s) && !TITLE_JUNK_RE.test(s) &&
      !BOILERPLATE_RE.test(s) && !isNameBlob(s) && !hasMarkerPrefix(s) &&
      !VENUE_HINT_RE.test(s) && commaCount(s) < 2;
    // Walk neighbours iteratively (titles wrap over 2–3 lines): backward
    // while the previous line looks like an unfinished title head (max 2),
    // then one short forward continuation. Generic shape checks only.
    const parts = [best];
    if (rawIdx >= 0) {
      for (let i = rawIdx - 1, n = 0; i >= 0 && n < 2; i--, n++) {
        const prev = stripped[i];
        if (!looksTitleish(prev) || prev.length > 120 || /[.!?]$/.test(prev)) break;
        if (parts.join(" ").length + prev.length + 1 > 250) break;
        parts.unshift(prev);
      }
      const nextRaw = rawIdx + 1 < stripped.length ? stripped[rawIdx + 1] : "";
      if (
        nextRaw && !pool.includes(nextRaw) && looksContinuation(nextRaw) &&
        parts.join(" ").length + nextRaw.length + 1 <= 250
      ) {
        parts.push(nextRaw);
      }
    }
    return { title: parts.join(" ").slice(0, 250), method: "heading" };
  }
  const firstLine = (clean.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "").slice(0, 200);
  if (firstLine.length > 20 && firstLine.length < 200) return { title: firstLine, method: "firstline" };
  return { title: base, method: "filename" };
}

/**
 * Conservative year extraction: only explicit imprint patterns
 * (© YYYY, Copyright YYYY, Date: YYYY-MM-DD). Never the first bare
 * 4-digit number in the body — that picks up timelines, version
 * histories, and reference lists instead of the publication year.
 */
export function extractYear(head: string): number | null {
  const h = (head ?? "").slice(0, 8000);
  const copy = h.match(/(©|copyright)\s*(©\s*)?((?:19|20)\d{2})/i);
  if (copy) return Number(copy[3]);
  const dated = h.match(/\bdate\s*[:–-]\s*((?:19|20)\d{2})(?:-\d{2}-\d{2})?/i);
  if (dated) return Number(dated[1]);
  const m = h.match(/((?:19|20)\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/);
  if (m) return Number(m[1]);
  return null;
}

/** First-page slice for the on-demand metadata-assist call. */
export function pageOneText(fullText: string, maxChars = 3000): string {
  return cleanPageMarkers(fullText).trim().slice(0, maxChars);
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

function guessTitle(filename: string, text: string): string {
  return extractTitleCandidate(text, filename).title;
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
  const buf = await file.arrayBuffer();
  // Never swallow extraction failures: a silent empty string becomes a
  // 0-chunk "metadata_only" row that looks like a scanned PDF but isn't.
  let textOut: { text: string; pageCount: number | null };
  let extractionError: string | null = null;
  try {
    textOut = await extractDocumentText(file);
  } catch (e) {
    extractionError = e instanceof Error ? e.message : String(e);
    textOut = { text: "", pageCount: null };
  }
  const [fileHash] = await Promise.all([sha256Hex(buf)]);
  const text = textOut.text;
  const textSnippet = text.slice(0, 2000);
  const doi = extractDoi(text.slice(0, 20000));
  // Conservative: only explicit imprint dates. A bare first-4-digit guess
  // used to pick timeline/reference years (e.g. 1978 out of a survey's
  // history section) and lock them in as the publication year.
  const year = extractYear(text);
  const title = guessTitle(file.name, text);
  const { docType } = classifyDocumentType(textSnippet, file.name);

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
    pageCount: textOut.pageCount,
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

export interface EmbeddedSlice {
  embedding: number[];
  model_name: string;
}

/**
 * Embed one text slice (identical policy for confirm + re-embed): local mode
 * uses the on-device Ollama model, server mode uses /api/rag/embed and must
 * return 768d. Throws on any failure — callers mark the document errored.
 * Slice is truncated to 2000 chars, matching the confirm pipeline exactly.
 */
export async function embedSlice(slice: string, embedMode: "local" | "server"): Promise<EmbeddedSlice> {
  const text = slice.slice(0, 2000);
  if (embedMode === "local") {
    return { embedding: await new OllamaProvider().embed(text), model_name: "nomic-embed-text" };
  }
  const res = await fetch("/api/rag/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode: "server" }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string }).error ?? "Server embedding failed (requires an OpenAI or Google key in Settings)");
  }
  const embedData = (await res.json()) as { embedding: number[]; model?: string };
  const embedding = embedData.embedding as number[];
  const embedModelName = embedData.model ?? "cloud-embedding-768d";
  // Schema is vector(768) for nomic-embed-text; a 1536d OpenAI vector
  // cannot be stored alongside. Fail loudly instead of leaving
  // chunks without embeddings that silently never match.
  if (embedding.length !== 768) {
    throw new Error(
      `Server embedding is ${embedding.length}d but the library stores 768d (nomic-embed-text). ` +
      `Upload with Embedding mode Local, or re-embed the whole library after migrating the column.`,
    );
  }
  return { embedding, model_name: embedModelName };
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
  const chunks = chunkTextWithPages(preview.text);
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
