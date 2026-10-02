// Makalah bibliography from stored metadata (deterministic).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { createClient } from "../../supabase/client";
import { docToCslItem, renderCitationPlain } from "../../citations";
import type { MakalahReference } from "./types";

export async function buildReferences(docIds: string[]): Promise<MakalahReference[]> {
  if (!docIds.length) return [];
  const sb = createClient();
  const { data: docs } = await sb
    .from("documents")
    .select("id, title, original_filename, year, journal, volume, issue, pages, publisher, doi, document_type")
    .in("id", docIds);
  const rows = (docs ?? []) as Array<Record<string, unknown>>;
  // Attach author names for citation rendering.
  const { data: da } = await sb
    .from("document_authors")
    .select("document_id, author_order, authors(name)")
    .in("document_id", docIds)
    .order("author_order");
  const authorsByDoc = new Map<string, string[]>();
  for (const r of (da ?? []) as Array<{
    document_id: string;
    authors: { name: string } | { name: string }[] | null;
  }>) {
    const name = Array.isArray(r.authors) ? r.authors[0]?.name : r.authors?.name;
    if (!name) continue;
    const list = authorsByDoc.get(r.document_id) ?? [];
    list.push(name);
    authorsByDoc.set(r.document_id, list);
  }
  return rows.map((d) => {
    const id = d.id as string;
    // Metadata fallback chain: extracted title → uploaded filename → id stub.
    // A cited source always yields an entry; thin entries are flagged by
    // isMalformedReference in the quality report instead of going missing.
    const title =
      ((d.title as string | null) ?? "").trim() ||
      ((d.original_filename as string | null) ?? "").trim() ||
      `Document ${id.slice(0, 8)}`;
    const item = docToCslItem({
      id,
      title,
      authors: authorsByDoc.get(id) ?? [],
      year: (d.year as number | null) ?? null,
      journal: (d.journal as string | null) ?? null,
      volume: (d.volume as string | null) ?? null,
      issue: (d.issue as string | null) ?? null,
      pages: (d.pages as string | null) ?? null,
      publisher: (d.publisher as string | null) ?? null,
      doi: (d.doi as string | null) ?? null,
      document_type: (d.document_type as string | null) ?? null,
    });
    return { id, formatted_apa7: renderCitationPlain(item) };
  });
}

export async function loadDocTitles(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const { data } = await createClient()
    .from("documents")
    .select("id, title, original_filename")
    .in("id", ids);
  for (const r of (data ?? []) as Array<{
    id: string;
    title: string | null;
    original_filename: string | null;
  }>) {
    map.set(r.id, r.title || r.original_filename || r.id.slice(0, 8));
  }
  return map;
}
