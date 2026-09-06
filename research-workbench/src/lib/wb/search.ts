// Grouped search (port of GET /api/search): Documents / Passages / Authors /
// Collections / Tags + structured filters (author:"…" year:2024 tag:… collection:"…").
import { createClient } from "@/lib/supabase/client";
import { getWorkspaceId, hydrateDocs, type HydratedDoc } from "./library";

export interface StructuredFilters {
  author?: string;
  year?: number;
  tag?: string;
  collection?: string;
  text: string;
}

export function parseFilters(q: string): StructuredFilters {
  const filters: StructuredFilters = { text: q };
  const authorM = q.match(/author:"([^"]+)"/i) ?? q.match(/author:(\S+)/i);
  if (authorM) {
    filters.author = authorM[1];
    filters.text = filters.text.replace(authorM[0], " ");
  }
  const yearM = q.match(/year:(\d{4})/i);
  if (yearM) {
    filters.year = Number(yearM[1]);
    filters.text = filters.text.replace(yearM[0], " ");
  }
  const tagM = q.match(/tag:([^\s]+)/i);
  if (tagM) {
    filters.tag = tagM[1].replace(/^#/, "");
    filters.text = filters.text.replace(tagM[0], " ");
  }
  const collM = q.match(/collection:"([^"]+)"/i) ?? q.match(/collection:([^\s]+)/i);
  if (collM) {
    filters.collection = collM[1];
    filters.text = filters.text.replace(collM[0], " ");
  }
  filters.text = filters.text.trim();
  return filters;
}

export interface SearchResult {
  query: string;
  filters: Record<string, unknown>;
  counts: { documents: number; passages: number; authors: number; collections: number; tags: number };
  results: {
    documents: HydratedDoc[];
    passages: Array<{ text: string; source: string; page: number | null; section: string | null; document_id: string }>;
    authors: Array<{ id: string; name: string }>;
    collections: Array<{ id: string; name: string; color: string; document_count: number }>;
    tags: Array<{ id: string; name: string }>;
  };
}

export async function groupedSearch(rawQuery: string, embedMode: "local" | "server" = "local"): Promise<SearchResult> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const f = parseFilters(rawQuery);
  const filters: Record<string, unknown> = {};
  if (f.author) filters.author = f.author;
  if (f.year) filters.year = f.year;
  if (f.tag) filters.tag = f.tag;
  if (f.collection) filters.collection = f.collection;

  // Documents leg
  let docQuery = sb.from("documents").select("*").eq("workspace_id", ws).eq("status", "approved").limit(20);
  if (f.text) docQuery = docQuery.ilike("title", `%${f.text}%`);
  if (f.year) docQuery = docQuery.eq("year", f.year);
  const { data: docsRaw } = await docQuery;
  let documents = await hydrateDocs((docsRaw ?? []) as Array<Record<string, unknown>>);
  if (f.author) {
    documents = documents.filter((d) => d.authors.some((a) => a.toLowerCase().includes(f.author!.toLowerCase())));
  }
  if (f.tag) {
    documents = documents.filter((d) => d.tags.some((t) => t.name.toLowerCase() === f.tag!.toLowerCase()));
  }
  if (f.collection) {
    documents = documents.filter((d) =>
      d.collections.some((c) => c.name.toLowerCase().includes(f.collection!.toLowerCase())),
    );
  }

  // Passages leg (reuse the hybrid retrieval path)
  let passages: SearchResult["results"]["passages"] = [];
  if (f.text) {
    try {
      const { retrieveContext } = await import("@/lib/rag/retrieve");
      const { passages: ps } = await retrieveContext({
        workspaceId: ws,
        query: f.text,
        topN: 10,
        embedMode,
      });
      const docTitles = new Map(documents.map((d) => [d.id, d.original_filename || d.title]));
      passages = ps.map((p) => ({
        text: p.content,
        source: docTitles.get(p.document_id) ?? p.document_id,
        page: p.page,
        section: p.section,
        document_id: p.document_id,
      }));
    } catch {
      passages = [];
    }
  }

  // Authors / collections / tags legs
  const q = f.text || f.author || f.tag || f.collection || "";
  const [{ data: authors }, { data: collections }, { data: tags }] = await Promise.all([
    q ? sb.from("authors").select("id, name").eq("workspace_id", ws).ilike("name", `%${q}%`).limit(20) : Promise.resolve({ data: [] }),
    q ? sb.from("collections").select("id, name, color").eq("workspace_id", ws).ilike("name", `%${q}%`).limit(20) : Promise.resolve({ data: [] }),
    q ? sb.from("tags").select("id, name").eq("workspace_id", ws).ilike("name", `%${q}%`).limit(20) : Promise.resolve({ data: [] }),
  ]);

  return {
    query: rawQuery,
    filters,
    counts: {
      documents: documents.length,
      passages: passages.length,
      authors: (authors ?? []).length,
      collections: (collections ?? []).length,
      tags: (tags ?? []).length,
    },
    results: {
      documents,
      passages,
      authors: (authors ?? []) as Array<{ id: string; name: string }>,
      collections: ((collections ?? []) as Array<{ id: string; name: string; color: string }>).map((c) => ({ ...c, document_count: 0 })),
      tags: (tags ?? []) as Array<{ id: string; name: string }>,
    },
  };
}

// Saved searches -------------------------------------------------------------
export async function listSavedSearches() {
  const ws = await getWorkspaceId();
  const { data, error } = await createClient()
    .from("saved_searches")
    .select("*")
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; name: string; query: string; filters_json: unknown }>;
}

export async function createSavedSearch(name: string, query: string) {
  const ws = await getWorkspaceId();
  const { error } = await createClient().from("saved_searches").insert({ workspace_id: ws, name, query });
  if (error) throw new Error(error.message);
}

export async function deleteSavedSearch(id: string) {
  const { error } = await createClient().from("saved_searches").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
