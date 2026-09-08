// Browser ingestion pipeline: preview (deterministic analysis, no upload) +
// confirm (Storage upload → rows → embeddings → pending approval).
// Preserves the UploadFlow "AI proposes, human confirms" contract.
import { createClient } from "@/lib/supabase/client";
import { sha256Hex, chunkText, extractPdfTextBrowser } from "@/lib/ingestion/chunking";
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

const YEAR_RE = /\b(19|20)\d{2}\b/;

// Supabase free tier ships ~1GB of storage: cap single uploads so one file
// (or a modified client ignoring the UI) can't fill the bucket. Matches the
// old backend's 150 MB cap.
export const MAX_FILE_BYTES = 150 * 1024 * 1024;

function assertFileSize(file: File): void {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  }
}

function guessTitle(filename: string, text: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const firstLine = (text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "").slice(0, 200);
  if (firstLine.length > 20 && firstLine.length < 200) return firstLine;
  return base || "Untitled";
}

export async function previewFile(file: File): Promise<IngestPreview> {
  assertFileSize(file);
  const buf = await file.arrayBuffer();
  // Never swallow extraction failures: a silent empty string becomes a
  // 0-chunk "metadata_only" row that looks like a scanned PDF but isn't.
  let textOut: { text: string; pageCount: number | null };
  let extractionError: string | null = null;
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    try {
      textOut = await extractPdfTextBrowser(file);
    } catch (e) {
      extractionError = e instanceof Error ? e.message : String(e);
      textOut = { text: "", pageCount: null };
    }
  } else {
    textOut = { text: await file.text(), pageCount: null };
  }
  const [fileHash] = await Promise.all([sha256Hex(buf)]);
  const text = textOut.text;
  const textSnippet = text.slice(0, 2000);
  const doi = extractDoi(text.slice(0, 20000));
  const yearM = text.slice(0, 20000).match(YEAR_RE);
  const year = yearM ? Number(yearM[0]) : null;
  const title = guessTitle(file.name, text);
  const { docType } = classifyDocumentType(textSnippet, file.name);

  const sb = createClient();
  const ws = await getWorkspaceId();
  const [{ data: existing }, collections] = await Promise.all([
    sb.from("documents").select("id, title, file_hash, doi, year").eq("workspace_id", ws).limit(500),
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

  const chunks = chunkText(preview.text);
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

  // Authors + collections (workspace-scoped upserts).
  if (input.authors.length) {
    for (let i = 0; i < input.authors.length; i++) {
      const name = input.authors[i];
      const { data: ex } = await sb.from("authors").select("id").eq("workspace_id", ws).eq("name", name).maybeSingle();
      let authorId = (ex as { id: string } | null)?.id;
      if (!authorId) {
        const { data: cr } = await sb.from("authors").insert({ workspace_id: ws, name }).select("id").single();
        authorId = (cr as { id: string } | null)?.id;
      }
      if (authorId) await sb.from("document_authors").insert({ document_id: docId, author_id: authorId, author_order: i });
    }
  }
  if (input.collectionIds.length) {
    await sb.from("document_collections").insert(
      input.collectionIds.map((collection_id) => ({ document_id: docId, collection_id })),
    );
  }
  // First-class bibliographic source row.
  await sb.from("sources").insert({
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

  let indexingError: string | null = null;
  if (chunks.length) {
    try {
      const { data: rows, error: chunkErr } = await sb
        .from("document_chunks")
        .insert(chunks.map((c) => ({ workspace_id: ws, document_id: docId, content: c.content, chunk_index: c.chunk_index })))
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
      indexingError = e instanceof Error ? e.message : "Embedding failed";
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
