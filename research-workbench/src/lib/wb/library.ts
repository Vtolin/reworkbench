// Workspace-scoped data access (Supabase). Replaces the FastAPI library routes.
// Every query is additionally RLS-gated server-side; these helpers shape the
// rows into the hydrated `{document, authors[], collections[], tags[]}` form
// the original UI expects.
import { createClient } from "@/lib/supabase/client";

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
  const ids = rows.map((r) => r.id as string);
  const [{ data: da }, { data: dc }, { data: dt }] = await Promise.all([
    sb.from("document_authors").select("document_id, author_order, authors(id, name)").in("document_id", ids),
    sb.from("document_collections").select("document_id, collections(id, name, color)").in("document_id", ids),
    sb.from("document_tags").select("document_id, tags(id, name)").in("document_id", ids),
  ]);
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
} = {}): Promise<{ documents: HydratedDoc[]; total: number }> {
  const ws = await getWorkspaceId();
  const sb = supabase();
  let query = sb
    .from("documents")
    .select("*", { count: "exact" })
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(200);
  if (params.q) query = query.ilike("title", `%${params.q}%`);
  if (params.year) query = query.eq("year", Number(params.year));
  if (params.doc_type) query = query.eq("document_type", params.doc_type);
  if (params.collection_id) {
    const { data: links } = await sb
      .from("document_collections")
      .select("document_id")
      .eq("collection_id", params.collection_id);
    const ids = (links ?? []).map((l) => l.document_id);
    if (!ids.length) return { documents: [], total: 0 };
    query = query.in("id", ids);
  }
  if (params.tag_id) {
    const { data: links } = await sb
      .from("document_tags")
      .select("document_id")
      .eq("tag_id", params.tag_id);
    const ids = (links ?? []).map((l) => l.document_id);
    if (!ids.length) return { documents: [], total: 0 };
    query = query.in("id", ids);
  }
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { documents: await hydrateDocs((data ?? []) as Array<Record<string, unknown>>), total: count ?? 0 };
}

export async function getDocument(id: string): Promise<HydratedDoc> {
  const sb = supabase();
  const { data, error } = await sb.from("documents").select("*").eq("id", id).single();
  if (error || !data) throw new Error(error?.message ?? "Document not found");
  const [doc] = await hydrateDocs([data as Record<string, unknown>]);
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
    // Upsert authors, then relink in order.
    const authorIds: string[] = [];
    for (const name of names) {
      const { data: existing } = await sb
        .from("authors")
        .select("id")
        .eq("workspace_id", ws)
        .eq("name", name)
        .maybeSingle();
      if (existing) {
        authorIds.push((existing as { id: string }).id);
      } else {
        const { data: created, error } = await sb
          .from("authors")
          .insert({ workspace_id: ws, name })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        authorIds.push((created as { id: string }).id);
      }
    }
    await sb.from("document_authors").delete().eq("document_id", id);
    if (authorIds.length) {
      await sb.from("document_authors").insert(
        authorIds.map((author_id, i) => ({ document_id: id, author_id, author_order: i })),
      );
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
  const out = [];
  for (const c of (data ?? []) as Array<{ id: string; name: string; color: string }>) {
    const { count } = await sb.from("document_collections").select("document_id", { count: "exact", head: true }).eq("collection_id", c.id);
    out.push({ ...c, document_count: count ?? 0 });
  }
  return out;
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
  const out = [];
  for (const t of (data ?? []) as Array<{ id: string; name: string }>) {
    const { count } = await sb.from("document_tags").select("document_id", { count: "exact", head: true }).eq("tag_id", t.id);
    out.push({ ...t, document_count: count ?? 0 });
  }
  return out;
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

export async function documentFileUrl(doc: { storage_path?: string | null }): Promise<string | null> {
  if (!doc.storage_path) return null;
  const { data, error } = await supabase().storage.from("documents").createSignedUrl(doc.storage_path, 3600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
