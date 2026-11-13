import { createClient } from "@/lib/supabase/client";
import { checkDuplicates, titleFuzzyScore } from "@/lib/ingestion/dedup";
import { resolveInitialDocumentStatus, shouldAutoApproveWorkspace } from "./autoApprove";
import { cleanDoi } from "./openalex";
import {
  DOCUMENT_COLUMNS_SELECT,
  deleteDocument,
  getWorkspaceId,
  hydrateDocs,
  updateDocument,
  type HydratedDoc,
} from "./library";
import { ensureAuthorIds } from "./taxonomy";

export interface ParsedIdentifier {
  doi?: string;
  isbn?: string;
  pmid?: string;
  title?: string;
}

export interface QuickAddInput {
  title: string;
  authors: string[];
  year: number | null;
  doi?: string | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  abstract?: string | null;
  document_type?: string | null;
  source_url?: string | null;
  metadata_source?: string | null;
  metadata_confidence?: number | null;
  collection_ids?: string[];
  allowDuplicate?: boolean;
}

export interface DuplicatePair {
  key: string;
  reason: "doi" | "title_exact" | "title_fuzzy";
  score: number;
  left: HydratedDoc;
  right: HydratedDoc;
}

const DOI_URL_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)(.+)$/i;
const BARE_DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const PMID_RE = /^(?:pmid:?\s*)(\d{6,9})$/i;
const NUMERIC_PMID_RE = /^(\d{7,9})$/;

export function parseIdentifierInput(raw: string): ParsedIdentifier {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const doiUrl = DOI_URL_RE.exec(trimmed);
  if (doiUrl) {
    const cleaned = cleanDoi(doiUrl[1]);
    if (cleaned) return { doi: cleaned };
  }
  if (BARE_DOI_RE.test(trimmed)) {
    const cleaned = cleanDoi(trimmed);
    if (cleaned) return { doi: cleaned };
  }

  const prefixedPmid = PMID_RE.exec(trimmed);
  if (prefixedPmid) return { pmid: prefixedPmid[1] };

  const digits = trimmed.replace(/[-\s]/g, "").replace(/^isbn:?\s*/i, "");
  if (/^(?:97[89]\d{10}|\d{9}[\dXx])$/.test(digits)) {
    return { isbn: digits.toUpperCase() };
  }

  const barePmid = NUMERIC_PMID_RE.exec(trimmed);
  if (barePmid) return { pmid: barePmid[1] };

  return { title: trimmed };
}

export function groupDuplicateCandidates(docs: HydratedDoc[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (seenPairs.has(pairKey)) continue;

      const doiA = cleanDoi(a.doi);
      const doiB = cleanDoi(b.doi);
      if (doiA && doiB && doiA === doiB) {
        seenPairs.add(pairKey);
        pairs.push({ key: pairKey, reason: "doi", score: 1, left: a, right: b });
        continue;
      }

      const titleA = a.title.trim().toLowerCase().replace(/\s+/g, " ");
      const titleB = b.title.trim().toLowerCase().replace(/\s+/g, " ");
      if (titleA && titleB && titleA === titleB) {
        seenPairs.add(pairKey);
        pairs.push({ key: pairKey, reason: "title_exact", score: 0.96, left: a, right: b });
        continue;
      }

      if (titleA && titleB) {
        const fuzzy = titleFuzzyScore(a.title, b.title);
        if (fuzzy >= 0.85) {
          seenPairs.add(pairKey);
          pairs.push({ key: pairKey, reason: "title_fuzzy", score: fuzzy, left: a, right: b });
        }
      }
    }
  }

  return pairs.sort((x, y) => y.score - x.score);
}

export async function quickAddDocument(
  input: QuickAddInput
): Promise<{ id: string; status: "approved" | "pending" }> {
  const title = input.title.trim();
  if (!title) throw new Error("Title is required");
  if (input.year != null && (input.year < 1400 || input.year > new Date().getFullYear() + 2)) {
    throw new Error(`Year ${input.year} looks out of range`);
  }

  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  const cleanedDoi = cleanDoi(input.doi);

  if (!input.allowDuplicate) {
    const { data: existing } = await sb
      .from("documents")
      .select("id, title, doi")
      .eq("workspace_id", ws)
      .order("created_at", { ascending: false })
      .limit(2000);
    const matches = checkDuplicates(
      { title, doi: cleanedDoi, authors: input.authors, year: input.year },
      (existing ?? []) as Array<{ id: string; title: string | null; doi: string | null }>
    );
    if (matches.length > 0) {
      throw new Error(`Possible duplicate found: "${matches[0].document.title ?? title}" (${matches[0].label})`);
    }
  }

  const initialStatus = resolveInitialDocumentStatus(await shouldAutoApproveWorkspace(sb, ws));

  const { data: inserted, error } = await sb
    .from("documents")
    .insert({
      workspace_id: ws,
      title,
      original_filename: `${cleanedDoi || title.slice(0, 48)}.ref`,
      doi: cleanedDoi,
      year: input.year,
      journal: input.journal ?? null,
      volume: input.volume ?? null,
      issue: input.issue ?? null,
      pages: input.pages ?? null,
      publisher: input.publisher ?? null,
      abstract: input.abstract ?? null,
      document_type: input.document_type ?? null,
      ingestion_status: "metadata_only",
      metadata_source: input.metadata_source ?? "quick_add",
      metadata_confidence: input.metadata_confidence ?? null,
      metadata_json: input.source_url ? { source_url: input.source_url } : {},
      status: initialStatus,
      uploaded_by: me.user?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    throw new Error(error?.message ?? "Failed to create reference record");
  }
  const docId = (inserted as { id: string }).id;

  if (input.authors.length > 0) {
    const resolved = await ensureAuthorIds(sb, ws, input.authors);
    const seen = new Set<string>();
    const links: Array<{ document_id: string; author_id: string; author_order: number }> = [];
    for (const r of resolved) {
      if (r.id && !seen.has(r.id)) {
        seen.add(r.id);
        links.push({ document_id: docId, author_id: r.id, author_order: links.length });
      }
    }
    if (links.length) await sb.from("document_authors").insert(links);
  }

  if (input.collection_ids?.length) {
    await sb
      .from("document_collections")
      .insert(input.collection_ids.map((collection_id) => ({ document_id: docId, collection_id })));
  }

  return { id: docId, status: initialStatus };
}

export async function findLibraryDuplicates(): Promise<DuplicatePair[]> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data, error } = await sb
    .from("documents")
    .select(DOCUMENT_COLUMNS_SELECT)
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const docs = await hydrateDocs((data ?? []) as unknown as Array<Record<string, unknown>>);
  return groupDuplicateCandidates(docs);
}

export async function mergeDuplicateDocuments(
  primaryId: string,
  secondaryId: string,
  patch: Record<string, unknown>
): Promise<void> {
  if (!primaryId || !secondaryId || primaryId === secondaryId) {
    throw new Error("Two distinct document IDs are required to merge");
  }

  const sb = createClient();
  const { data: docs, error: fetchErr } = await sb
    .from("documents")
    .select("id, storage_path, file_hash, file_size, mime_type, page_count, ingestion_status")
    .in("id", [primaryId, secondaryId]);
  if (fetchErr) throw new Error(fetchErr.message);

  const primaryRow = (docs ?? []).find((d) => (d as { id: string }).id === primaryId) as
    | { id: string; storage_path: string | null; file_hash: string | null; file_size: number | null; mime_type: string | null; page_count: number | null; ingestion_status: string }
    | undefined;
  const secondaryRow = (docs ?? []).find((d) => (d as { id: string }).id === secondaryId) as
    | typeof primaryRow
    | undefined;

  if (!primaryRow || !secondaryRow) {
    throw new Error("One or both documents no longer exist");
  }

  await updateDocument(primaryId, patch);

  // Preserve uploaded binary reference if primary is metadata-only and secondary has the PDF.
  if (!primaryRow.storage_path && secondaryRow.storage_path) {
    const { error: moveFileErr } = await sb
      .from("documents")
      .update({
        storage_path: secondaryRow.storage_path,
        file_hash: secondaryRow.file_hash,
        file_size: secondaryRow.file_size,
        mime_type: secondaryRow.mime_type,
        page_count: secondaryRow.page_count,
        ingestion_status: secondaryRow.ingestion_status,
      })
      .eq("id", primaryId);
    if (moveFileErr) throw new Error(moveFileErr.message);
    await sb.from("documents").update({ storage_path: null }).eq("id", secondaryId);
  }

  // Migrate annotations onto primary document.
  await sb.from("annotations").update({ document_id: primaryId }).eq("document_id", secondaryId);

  // Merge collection links without duplicate primary key errors.
  const [pCols, sCols] = await Promise.all([
    sb.from("document_collections").select("collection_id").eq("document_id", primaryId),
    sb.from("document_collections").select("collection_id").eq("document_id", secondaryId),
  ]);
  const existingColIds = new Set(((pCols.data ?? []) as Array<{ collection_id: string }>).map((r) => r.collection_id));
  const missingCols = ((sCols.data ?? []) as Array<{ collection_id: string }>)
    .map((r) => r.collection_id)
    .filter((id) => !existingColIds.has(id));
  if (missingCols.length) {
    await sb
      .from("document_collections")
      .insert(missingCols.map((collection_id) => ({ document_id: primaryId, collection_id })));
  }

  // Merge tag links.
  const [pTags, sTags] = await Promise.all([
    sb.from("document_tags").select("tag_id").eq("document_id", primaryId),
    sb.from("document_tags").select("tag_id").eq("document_id", secondaryId),
  ]);
  const existingTagIds = new Set(((pTags.data ?? []) as Array<{ tag_id: string }>).map((r) => r.tag_id));
  const missingTags = ((sTags.data ?? []) as Array<{ tag_id: string }>)
    .map((r) => r.tag_id)
    .filter((id) => !existingTagIds.has(id));
  if (missingTags.length) {
    await sb.from("document_tags").insert(missingTags.map((tag_id) => ({ document_id: primaryId, tag_id })));
  }

  // Merge project memberships.
  const [pProj, sProj] = await Promise.all([
    sb.from("research_project_documents").select("project_id").eq("document_id", primaryId),
    sb.from("research_project_documents").select("project_id").eq("document_id", secondaryId),
  ]);
  const existingProjIds = new Set(((pProj.data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id));
  const missingProjs = ((sProj.data ?? []) as Array<{ project_id: string }>)
    .map((r) => r.project_id)
    .filter((id) => !existingProjIds.has(id));
  if (missingProjs.length) {
    await sb
      .from("research_project_documents")
      .insert(missingProjs.map((project_id) => ({ document_id: primaryId, project_id })));
  }

  await deleteDocument(secondaryId);
}
