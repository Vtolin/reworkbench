// Workspace-scoped data access (Supabase). Replaces the FastAPI library routes.
// Every query is additionally RLS-gated server-side; these helpers shape the
// rows into the hydrated `{document, authors[], collections[], tags[]}` form
// the original UI expects.
//
// Ownership rules (Phase 6): this module owns the document column list
// (DOCUMENT_COLUMNS_SELECT — extend it when the schema grows), row hydration
// (hydrateDocs), and workspace-id resolution (getWorkspaceId). It contains NO
// domain logic: no retrieval, no inference, no filtering beyond the
// caller-supplied predicates in docFilters. Do NOT split it — the column
// list, hydration, and scoping must stay in one place to stay consistent.
import { createClient } from "@/lib/supabase/client";
import { chunkArray } from "@/lib/async/pool";
import { escapeLike } from "@/lib/supabase/like";
import { linkFilterCalls, linkJoinSelects, type DocLinkFilter } from "./docFilters";
import { ensureAuthorIds } from "./taxonomy";

export interface HydratedDoc {
  id: string;
  title: string;
  original_filename: string;
  created_at: string;
  storage_path: string | null;
  file_hash: string | null;
  file_size: number | null;
  mime_type: string | null;
  doi: string | null;
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  abstract: string | null;
  jurisdiction: string | null;
  document_type: string | null;
  page_count: number | null;
  ingestion_status: string;
  ingestion_error: string | null;
  metadata_json: Record<string, unknown>;
  citation_metadata: Record<string, unknown>;
  metadata_source: string | null;
  metadata_fetched_at: string | null;
  metadata_confidence: number | null;
  metadata_verified: boolean;
  status: string;
  authors: string[];
  collections: Array<{ id: string; name: string; color: string }>;
  tags: Array<{ id: string; name: string }>;
}

function supabase() {
  return createClient();
}

// Explicit document column list (Task M): `select("*")` on documents also
// ships the generated `fts` tsvector (KBs per row — 200-row library loads,
// 1000-row exports). Every HydratedDoc scalar plus the row-identity columns
// callers need (workspace_id / uploaded_by / updated_at are read off raw
// rows in a few flows); `fts` is the only exclusion, and nothing reads it
// (full-text goes through the fts_search_chunks RPC).
// ADD NEW documents COLUMNS HERE when the schema grows: the compile-time
// assertion below fails the build if a HydratedDoc scalar is not listed.
export const DOCUMENT_COLUMNS = [
  "id", "workspace_id", "title", "original_filename", "storage_path",
  "file_hash", "file_size", "mime_type", "doi", "year", "journal", "volume",
  "issue", "pages", "publisher", "abstract", "jurisdiction", "document_type",
  "page_count", "ingestion_status", "ingestion_error", "metadata_json",
  "citation_metadata", "metadata_source", "metadata_fetched_at",
  "metadata_confidence", "metadata_verified", "status", "uploaded_by",
  "created_at", "updated_at",
] as const;

export const DOCUMENT_COLUMNS_SELECT = DOCUMENT_COLUMNS.join(", ");

type _HydratedDocScalars = Exclude<keyof HydratedDoc, "authors" | "collections" | "tags">;
type _ColumnsCoverHydratedDoc = Exclude<_HydratedDocScalars, (typeof DOCUMENT_COLUMNS)[number]> extends never
  ? true
  : never;
const _columnsCoverHydratedDoc: _ColumnsCoverHydratedDoc = true;
void _columnsCoverHydratedDoc;

export async function getWorkspaceId(): Promise<string> {
  const sb = supabase();
  const { data: me } = await sb.auth.getUser();
  if (!me.user) throw new Error("Not signed in");
  const { data: m } = await sb
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", me.user.id)
    .eq("status", "active")
    .order("joined_at")
    .limit(1)
    .maybeSingle();
  if (!m) throw new Error("No workspace — ask your admin for access");
  return (m as { workspace_id: string }).workspace_id;
}

export async function hydrateDocs(rows: Array<Record<string, unknown>>): Promise<HydratedDoc[]> {
  if (!rows.length) return [];
  const sb = supabase();
  // Chunked `IN (...)` lists (see IN_CHUNK_SIZE): project views can hydrate
  // thousands of documents, and an unbounded IN clause blows past URL limits
  // long before the database notices. Same 3 set-based queries per chunk.
  const ids = rows.map((r) => r.id as string);
  const da: unknown[] = [];
  const dc: unknown[] = [];
  const dt: unknown[] = [];
  for (const batch of chunkArray(ids)) {
    const [{ data: a }, { data: c }, { data: t }] = await Promise.all([
      sb.from("document_authors").select("document_id, author_order, authors(id, name)").in("document_id", batch),
      sb.from("document_collections").select("document_id, collections(id, name, color)").in("document_id", batch),
      sb.from("document_tags").select("document_id, tags(id, name)").in("document_id", batch),
    ]);
    da.push(...((a ?? []) as unknown[]));
    dc.push(...((c ?? []) as unknown[]));
    dt.push(...((t ?? []) as unknown[]));
  }
  const byDoc = new Map<string, HydratedDoc>();
  for (const r of rows) {
    byDoc.set(r.id as string, {
      ...(r as unknown as Omit<HydratedDoc, "authors" | "collections" | "tags">),
      metadata_json: (r.metadata_json as Record<string, unknown>) ?? {},
      citation_metadata: (r.citation_metadata as Record<string, unknown>) ?? {},
      authors: [],
      collections: [],
      tags: [],
    });
  }
  for (const row of (((da ?? []) as unknown) as Array<{
    document_id: string; author_order: number; authors: { id: string; name: string } | null;
  }>).sort((a, b) => a.author_order - b.author_order)) {
    const d = byDoc.get(row.document_id);
    if (d && row.authors) d.authors.push(row.authors.name);
  }
  for (const row of (((dc ?? []) as unknown) as Array<{
    document_id: string; collections: { id: string; name: string; color: string } | null;
  }>)) {
    const d = byDoc.get(row.document_id);
    if (d && row.collections) d.collections.push(row.collections);
  }
  for (const row of (((dt ?? []) as unknown) as Array<{
    document_id: string; tags: { id: string; name: string } | null;
  }>)) {
    const d = byDoc.get(row.document_id);
    if (d && row.tags) d.tags.push(row.tags);
  }
  return [...byDoc.values()];
}

export async function listDocuments(params: {
  q?: string;
  collection_id?: string;
  tag_id?: string;
  year?: string;
  doc_type?: string;
  /** Page size for the user-facing library list. Bounded: 1..200, default 200. */
  limit?: number;
  /** Zero-based offset into the created_at-desc ordering. Default 0. */
  offset?: number;
} = {}): Promise<{ documents: HydratedDoc[]; total: number }> {
  const ws = await getWorkspaceId();
  const sb = supabase();
  // Explicit cardinality bound (Task E): the library list is user-facing and
  // unbounded, so page size is clamped and offset is supported instead of
  // "fetch everything". Defaults preserve the previous behavior exactly
  // (first 200, newest first).
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  // Collection/tag filters as server-side semi-joins instead of the old
  // two-step (fetch ALL link ids, then `.in("id", ids)`): the link prefetch
  // had no LIMIT, so a large collection built an unbounded IN clause and
  // pulled every link row into the browser. `!inner` keeps filtering
  // set-based with the range applied server-side; the join PK guarantees one
  // link per (document, collection/tag), so row counts are unaffected.
  // The auxiliary nested keys are stripped before hydration to keep the
  // HydratedDoc shape unchanged.
  // Shared with grouped search (docFilters): one predicate implementation.
  const linkFilter: DocLinkFilter = {
    ...(params.collection_id ? { collectionIds: [params.collection_id] } : {}),
    ...(params.tag_id ? { tagIds: [params.tag_id] } : {}),
  };
  const joins = linkJoinSelects(linkFilter);
  let query = sb
    .from("documents")
    .select(joins.length ? `${DOCUMENT_COLUMNS_SELECT}, ${joins.join(", ")}` : DOCUMENT_COLUMNS_SELECT, { count: "exact" })
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  for (const call of linkFilterCalls(linkFilter)) query = query.in(call.column, call.values);
  if (params.q) query = query.ilike("title", `%${escapeLike(params.q)}%`);
  if (params.year) query = query.eq("year", Number(params.year));
  if (params.doc_type) query = query.eq("document_type", params.doc_type);
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  // `as unknown` first: the `!inner` join select defeats supabase-js's
  // response-type inference (untyped schema), so `data` is not directly
  // comparable to a record array.
  const cleaned = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const { document_collections, document_tags, ...rest } = r;
    return rest;
  });
  return { documents: await hydrateDocs(cleaned), total: count ?? 0 };
}

export async function getDocument(id: string): Promise<HydratedDoc> {
  const sb = supabase();
  const { data, error } = await sb.from("documents").select(DOCUMENT_COLUMNS_SELECT).eq("id", id).single();
  if (error || !data) throw new Error(error?.message ?? "Document not found");
  const [doc] = await hydrateDocs([data as unknown as Record<string, unknown>]);
  return doc;
}

// Present-keys-only patch (mirrors core/library/documents.py update_document:
// only keys the user sent are applied, so partial edits can't wipe fields).
export async function updateDocument(id: string, patch: Record<string, unknown>): Promise<void> {
  const sb = supabase();
  const scalarKeys = [
    "title", "doi", "year", "journal", "jurisdiction", "document_type", "abstract",
    "volume", "issue", "pages", "publisher", "citation_metadata", "metadata_source",
    "metadata_confidence", "metadata_verified",
  ];
  const scalar: Record<string, unknown> = {};
  for (const k of scalarKeys) {
    if (k in patch) scalar[k] = patch[k];
  }
  if (Object.keys(scalar).length) {
    const { error } = await sb.from("documents").update(scalar).eq("id", id);
    if (error) throw new Error(error.message);
  }
  if ("authors" in patch && Array.isArray(patch.authors)) {
    const ws = await getWorkspaceId();
    const names = (patch.authors as string[]).map((a) => a.trim()).filter(Boolean);
    // Upsert authors, then relink in order — set-based (one SELECT + one
    // bulk INSERT for resolution, one bulk INSERT for the links). Resolution
    // failures still throw, exactly as before; link INSERT keeps the
    // established silent policy (unchanged behavior).
    const resolved = await ensureAuthorIds(sb, ws, names);
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i].error) throw new Error(resolved[i].error);
    }
    const seen = new Set<string>();
    const links: Array<{ document_id: string; author_id: string; author_order: number }> = [];
    for (const r of resolved) {
      if (r.id && !seen.has(r.id)) {
        seen.add(r.id);
        links.push({ document_id: id, author_id: r.id, author_order: links.length });
      }
    }
    await sb.from("document_authors").delete().eq("document_id", id);
    if (links.length) {
      await sb.from("document_authors").insert(links);
    }
  }
}

export async function deleteDocument(id: string): Promise<void> {
  const sb = supabase();
  const { data: doc } = await sb.from("documents").select("storage_path").eq("id", id).single();
  const { error } = await sb.from("documents").delete().eq("id", id);
  if (error) throw new Error(error.message);
  const path = (doc as { storage_path?: string } | null)?.storage_path;
  if (path) await sb.storage.from("documents").remove([path]);
}

export async function setDocCollections(id: string, collectionIds: string[]): Promise<void> {
  const sb = supabase();
  await sb.from("document_collections").delete().eq("document_id", id);
  if (collectionIds.length) {
    const { error } = await sb
      .from("document_collections")
      .insert(collectionIds.map((collection_id) => ({ document_id: id, collection_id })));
    if (error) throw new Error(error.message);
  }
}

export async function setDocTags(id: string, tagIds: string[]): Promise<void> {
  const sb = supabase();
  await sb.from("document_tags").delete().eq("document_id", id);
  if (tagIds.length) {
    const { error } = await sb
      .from("document_tags")
      .insert(tagIds.map((tag_id) => ({ document_id: id, tag_id })));
    if (error) throw new Error(error.message);
  }
}

export async function listCollections(): Promise<Array<{ id: string; name: string; color: string; document_count: number }>> {
  const ws = await getWorkspaceId();
  const sb = supabase();
  const { data, error } = await sb.from("collections").select("id, name, color").eq("workspace_id", ws).order("name");
  if (error) throw new Error(error.message);
  // Set-based counts (migration 0007): one GROUP BY RPC instead of one
  // head-count query per collection (1+N -> 2 queries total). Buckets the
  // RPC omits are empty collections -> 0, exactly as before.
  const { data: counts, error: countErr } = await sb.rpc("collection_doc_counts", { ws_id: ws });
  if (countErr) throw new Error(countErr.message);
  const byId = new Map(
    ((counts ?? []) as Array<{ collection_id: string; document_count: number }>).map((c) => [c.collection_id, Number(c.document_count)]),
  );
  return ((data ?? []) as Array<{ id: string; name: string; color: string }>).map((c) => ({
    ...c,
    document_count: byId.get(c.id) ?? 0,
  }));
}

export async function createCollection(name: string): Promise<void> {
  const ws = await getWorkspaceId();
  const { error } = await supabase().from("collections").insert({ workspace_id: ws, name: name.trim() });
  if (error) throw new Error(error.message);
}

export async function listTags(): Promise<Array<{ id: string; name: string; document_count: number }>> {
  const ws = await getWorkspaceId();
  const sb = supabase();
  const { data, error } = await sb.from("tags").select("id, name").eq("workspace_id", ws).order("name");
  if (error) throw new Error(error.message);
  // Set-based counts (migration 0007): one GROUP BY RPC instead of one
  // head-count query per tag (1+N -> 2 queries total).
  const { data: counts, error: countErr } = await sb.rpc("tag_doc_counts", { ws_id: ws });
  if (countErr) throw new Error(countErr.message);
  const byId = new Map(
    ((counts ?? []) as Array<{ tag_id: string; document_count: number }>).map((t) => [t.tag_id, Number(t.document_count)]),
  );
  return ((data ?? []) as Array<{ id: string; name: string }>).map((t) => ({
    ...t,
    document_count: byId.get(t.id) ?? 0,
  }));
}

export async function createTag(name: string): Promise<void> {
  const ws = await getWorkspaceId();
  const { error } = await supabase().from("tags").insert({ workspace_id: ws, name: name.trim() });
  if (error) throw new Error(error.message);
}

export async function libraryStats(): Promise<{ total: number; collections: number; tags: number }> {
  const ws = await getWorkspaceId();
  const sb = supabase();
  const [{ count: total }, { count: collections }, { count: tags }] = await Promise.all([
    sb.from("documents").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("status", "approved"),
    sb.from("collections").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
    sb.from("tags").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
  ]);
  return { total: total ?? 0, collections: collections ?? 0, tags: tags ?? 0 };
}

export async function chunkCount(): Promise<number> {
  const ws = await getWorkspaceId();
  const { count } = await supabase()
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ws);
  return count ?? 0;
}

export async function documentFileUrl(doc: { id?: string; storage_path?: string | null }): Promise<string | null> {
  if (!doc.storage_path) return null;
  const sb = supabase();
  // RLS pre-check: never mint a signed URL (which bypasses storage RLS) for a
  // document row the caller cannot read.
  if (doc.id) {
    const { data: allowed } = await sb.from("documents").select("id").eq("id", doc.id).maybeSingle();
    if (!allowed) throw new Error("Document not found");
  }
  const { data, error } = await sb.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
