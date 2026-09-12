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
import { OllamaProvider } from "@/lib/ai/ollama";

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
    sb.from("documents").select("id, title, file_hash, doi, year").eq("workspace_id", ws).limit(2000),
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

export async function confirmIngest(input: ConfirmInput): Promise<{
  document: ConfirmedDocument;
  indexingError: string | null;
}> {
  const { file, preview } = input;
  assertFileSize(file);
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
  if (docErr || !doc) throw new Error(docErr?.message ?? "Document insert failed");
  const docId = (doc as { id: string }).id;

  // Authors + collections (workspace-scoped upserts). Link failures are
  // collected (not thrown): the document row is the source of truth, but
  // the caller must surface what didn't attach.
  const linkErrors: string[] = [];
  if (input.authors.length) {
    for (let i = 0; i < input.authors.length; i++) {
      const name = input.authors[i];
      const { data: ex } = await sb.from("authors").select("id").eq("workspace_id", ws).eq("name", name).maybeSingle();
      let authorId = (ex as { id: string } | null)?.id;
      if (!authorId) {
        const { data: cr, error: crErr } = await sb.from("authors").insert({ workspace_id: ws, name }).select("id").single();
        if (crErr) linkErrors.push(`author "${name}": ${crErr.message}`);
        authorId = (cr as { id: string } | null)?.id;
      }
      if (authorId) {
        const { error: linkErr } = await sb.from("document_authors").insert({ document_id: docId, author_id: authorId, author_order: i });
        if (linkErr) linkErrors.push(`author link "${name}": ${linkErr.message}`);
      } else if (!linkErrors.some((m) => m.includes(`"${name}"`))) {
        linkErrors.push(`author "${name}": unresolved`);
      }
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
      for (const row of (rows ?? []) as Array<{ id: string; content: string }>) {
        const slice = row.content.slice(0, 2000);
        let embedding: number[];
        let embedModelName = "nomic-embed-text";
        if (input.embedMode === "local") {
          embedding = await new OllamaProvider().embed(slice);
        } else {
          const res = await fetch("/api/rag/embed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: slice, mode: "server" }),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            throw new Error((errBody as { error?: string }).error ?? "Server embedding failed (requires OpenAI key in Settings)");
          }
          embedding = (await res.json()).embedding as number[];
          embedModelName = "text-embedding-3-small";
          // Schema is vector(768) for nomic-embed-text; a 1536d OpenAI vector
          // cannot be stored alongside. Fail loudly instead of leaving
          // chunks without embeddings that silently never match.
          if (embedding.length !== 768) {
            throw new Error(
              `Server embedding is ${embedding.length}d but the library stores 768d (nomic-embed-text). ` +
              `Upload with Embedding mode Local, or re-embed the whole library after migrating the column.`,
            );
          }
        }
        const { error: embErr } = await sb.from("document_embeddings").insert({
          chunk_id: row.id,
          embedding,
          model_name: embedModelName,
        });
        if (embErr) throw new Error(embErr.message);
      }
    } catch (e) {
      const embedErr = e instanceof Error ? e.message : "Embedding failed";
      indexingError = indexingError ? `${indexingError} | embedding: ${embedErr}` : embedErr;
      await sb.from("documents").update({ ingestion_status: "error", ingestion_error: indexingError }).eq("id", docId);
    }
  }

  const { data: fresh } = await sb
    .from("documents")
    .select("id, title, storage_path, ingestion_status, metadata_source, metadata_confidence")
    .eq("id", docId)
    .single();
  return {
    document: fresh as unknown as ConfirmedDocument,
    indexingError,
  };
}
