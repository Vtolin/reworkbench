// Feature API: reference import / export (BibTeX, RIS, CSL-JSON, EndNote).
// Extracted verbatim from lib/api.ts (Phase 5); behavior unchanged.
import { createClient } from "../supabase/client";
import { DOCUMENT_COLUMNS_SELECT, getWorkspaceId, type HydratedDoc } from "../wb/library";
import { parseReferences, type ImportRecord } from "../importing/parsers";
import { checkDuplicates } from "../ingestion/dedup";
import { ensureAuthorIds } from "../wb/taxonomy";
import {
  docToCslItem, renderBibliography, bibtexEntry, risEntry, plainCitation,
} from "../citations/csl";

async function exportDocs(ids?: string[]): Promise<HydratedDoc[]> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  // Bounded export window (1000 newest): user-triggered, intentionally capped
  // rather than paginated — a full-workspace dump for larger libraries is
  // future work (see exportWorkspace). Explicit columns: skip the fts vector.
  let q = sb.from("documents").select(DOCUMENT_COLUMNS_SELECT).eq("workspace_id", ws).eq("status", "approved").order("created_at", { ascending: false }).limit(1000);
  if (ids?.length) q = q.in("id", ids);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const { hydrateDocs } = await import("../wb/library");
  return hydrateDocs((data ?? []) as unknown as Array<Record<string, unknown>>);
}

async function importRecords(records: ImportRecord[]): Promise<{ imported: number; skipped: number }> {
  if (!records.length) return { imported: 0, skipped: 0 };
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  // Bounded duplicate-detection window (2000 newest, deterministic order):
  // exact doi hits are order-independent; title-fuzzy needs a stable set.
  const { data: existing } = await sb.from("documents").select("id, title, doi").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(2000);
  const existingDocs = ((existing ?? []) as Array<{ id: string; title: string | null; doi: string | null }>).map((d) => ({
    id: d.id,
    title: d.title,
    doi: d.doi,
  }));
  // Authors are resolved per record (batched: one SELECT + one bulk INSERT
  // per record instead of 2 queries per author) rather than once upfront:
  // skipped (duplicate) records must not create author rows as a side
  // effect. Failures keep the established silent-skip policy (unresolved
  // names simply get no link).
  // Collections repeat across records too: resolve-or-create once per name,
  // then reuse. Insert races (two imports creating the same collection) fall
  // back to a re-read before giving up and skipping the link silently.
  const collectionIdByName = new Map<string, string>();
  async function ensureCollectionId(cname: string): Promise<string | null> {
    const hit = collectionIdByName.get(cname);
    if (hit) return hit;
    const { data: ex } = await sb.from("collections").select("id").eq("workspace_id", ws).eq("name", cname).maybeSingle();
    let colId = (ex as { id: string } | null)?.id ?? null;
    if (!colId) {
      const { data: cr, error } = await sb.from("collections").insert({ workspace_id: ws, name: cname }).select("id").single();
      colId = (cr as { id: string } | null)?.id ?? null;
      if (!colId && error) {
        const { data: retry } = await sb.from("collections").select("id").eq("workspace_id", ws).eq("name", cname).maybeSingle();
        colId = (retry as { id: string } | null)?.id ?? null;
      }
    }
    if (colId) collectionIdByName.set(cname, colId);
    return colId;
  }
  let imported = 0;
  let skipped = 0;
  for (const r of records) {
    const dups = checkDuplicates(
      { title: r.title, doi: r.doi, authors: r.authors, year: r.year },
      existingDocs,
    );
    if (dups.length) {
      skipped++;
      continue;
    }
    const { data: doc, error } = await sb
      .from("documents")
      .insert({
        workspace_id: ws,
        title: r.title ?? "(untitled)",
        original_filename: `${r.rawKey ?? r.title ?? "import"}.ref`,
        doi: r.doi,
        year: r.year,
        journal: r.journal,
        volume: r.volume,
        issue: r.issue,
        pages: r.pages,
        publisher: r.publisher,
        abstract: r.abstract,
        ingestion_status: "metadata_only",
        status: "pending",
        uploaded_by: me.user?.id ?? null,
      })
      .select("id")
      .single();
    if (error || !doc) {
      skipped++;
      continue;
    }
    const docId = (doc as { id: string }).id;
    if (r.authors.length) {
      const resolved = await ensureAuthorIds(sb, ws, r.authors);
      const seen = new Set<string>();
      const links: Array<{ document_id: string; author_id: string; author_order: number }> = [];
      for (const res of resolved) {
        if (res.id && !seen.has(res.id)) {
          seen.add(res.id);
          links.push({ document_id: docId, author_id: res.id, author_order: links.length });
        }
      }
      // Silent skip on failure (established import behavior).
      if (links.length) await sb.from("document_authors").insert(links);
    }
    const colLinks: Array<{ document_id: string; collection_id: string }> = [];
    for (const cname of r.collections.slice(0, 5)) {
      const colId = await ensureCollectionId(cname);
      if (colId) colLinks.push({ document_id: docId, collection_id: colId });
    }
    if (colLinks.length) await sb.from("document_collections").insert(colLinks);
    existingDocs.push({ id: docId, title: r.title, doi: r.doi });
    imported++;
  }
  return { imported, skipped };
}

export const importsApi = {
  importRefs: async (text: string, format?: string) => {
    const records = parseReferences(text, format);
    return importRecords(records);
  },
  importFile: async (file: File) => {
    const text = await file.text();
    const ext = file.name.split(".").pop()?.toLowerCase();
    const fmt = ext === "bib" ? "bibtex" : ext === "ris" ? "ris" : ext === "json" ? "csl-json" : ext === "xml" ? "endnote-xml" : undefined;
    return importRecords(parseReferences(text, fmt));
  },
  exportRefs: async (format: string, ids?: string[]) => {
    const docs = await exportDocs(ids);
    const fmt = format.toLowerCase();
    if (fmt === "ris") return { data: docs.map(risEntry).join("\n") };
    if (fmt === "csl-json" || fmt === "csl_json" || fmt === "json") {
      return { data: JSON.stringify(docs.map(docToCslItem), null, 2) };
    }
    return { data: docs.map(bibtexEntry).join("\n\n") };
  },
  exportBibliography: async (style: string, ids?: string[]) => {
    const docs = await exportDocs(ids);
    const entries = await renderBibliography(docs.map(docToCslItem), style).catch(() => docs.map((d) => plainCitation(d)));
    return { bibliography: entries };
  },
};
