import { escapeLike } from "@/lib/supabase/like";

// Unified document link predicates (Phase 5: search scalability).
//
// library.ts filtered collections/tags by ID with server-side semi-joins
// while search.ts filtered author/tag/collection names client-side AFTER a
// LIMIT — so page 1 was wrong whenever the filter bit past the first 20
// rows. Both paths now share one implementation: names resolve to bounded ID
// sets (resolveDocLinkIds), then a single semi-join shape (linkJoinSelects +
// linkFilterCalls) filters server-side with the range applied on top.
//
// Deliberately free of supabase-js types: callers pass a plain fetcher and
// apply the descriptor calls inline, so tsc never instantiates the giant
// postgrest builder generics through this module (that sends type-checking
// infinitely deep). The WHAT (columns, patterns, exact-vs-contains) lives
// here exactly once; the two call sites are dumb loops.

export interface DocLinkFilter {
  collectionIds?: string[];
  tagIds?: string[];
  authorIds?: string[];
}

export interface DocNameFilter {
  author?: string;
  tag?: string;
  collection?: string;
}

/** `!inner` semi-join selects: set-based filtering, one link per pair. */
export function linkJoinSelects(f: DocLinkFilter): string[] {
  const joins: string[] = [];
  if (f.collectionIds?.length) joins.push("document_collections!inner(collection_id)");
  if (f.tagIds?.length) joins.push("document_tags!inner(tag_id)");
  if (f.authorIds?.length) joins.push("document_authors!inner(author_id)");
  return joins;
}

export interface LinkFilterCall {
  column: string;
  values: string[];
}

/** Link-table IN predicates, one per filtered dimension. */
export function linkFilterCalls(f: DocLinkFilter): LinkFilterCall[] {
  const calls: LinkFilterCall[] = [];
  if (f.collectionIds?.length) {
    calls.push({ column: "document_collections.collection_id", values: f.collectionIds });
  }
  if (f.tagIds?.length) calls.push({ column: "document_tags.tag_id", values: f.tagIds });
  if (f.authorIds?.length) calls.push({ column: "document_authors.author_id", values: f.authorIds });
  return calls;
}

/** Name-table source for one dimension (callers bind workspace + LIMIT). */
export type LinkIdFetcher = (
  table: "authors" | "tags" | "collections",
  pattern: string,
) => Promise<string[]>;

const RESOLVE_LIMIT = 20;

/** How many IDs a resolution leg may return (IN lists stay small). */
export function resolveLimit(): number {
  return RESOLVE_LIMIT;
}

/**
 * Resolve author/tag/collection NAME filters to bounded ID sets. Tag uses
 * case-insensitive exact match (the old client semantics); author/collection
 * use contains. LIKE metacharacters are escaped, so user input stays literal.
 * A requested-but-unmatched filter yields an empty set — callers treat that
 * as "match nothing", which keeps page 1 correct.
 */
export async function resolveDocLinkIds(
  fetchIds: LinkIdFetcher,
  f: DocNameFilter,
): Promise<DocLinkFilter> {
  const out: DocLinkFilter = {};
  if (f.author) out.authorIds = await fetchIds("authors", `%${escapeLike(f.author)}%`);
  if (f.tag) out.tagIds = await fetchIds("tags", escapeLike(f.tag));
  if (f.collection) out.collectionIds = await fetchIds("collections", `%${escapeLike(f.collection)}%`);
  return out;
}

/** True when every requested dimension matched at least one ID. */
export function linkFilterMatched(f: DocNameFilter, ids: DocLinkFilter): boolean {
  return (
    (!f.author || (ids.authorIds?.length ?? 0) > 0) &&
    (!f.tag || (ids.tagIds?.length ?? 0) > 0) &&
    (!f.collection || (ids.collectionIds?.length ?? 0) > 0)
  );
}
