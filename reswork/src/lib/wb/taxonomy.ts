// Workspace-scoped taxonomy resolution (authors).
// Single source of truth for the find-or-create author pattern previously
// copied across importRecords, confirmIngest, and updateDocument (Phase 6).
// The helper performs the queries and reports the outcome; FAILURE POLICY
// stays with the caller (silent skip vs collected vs throw), so each
// adoption preserves its existing observable behavior exactly.
import { createClient } from "@/lib/supabase/client";
import { chunkArray } from "@/lib/async/pool";

type BrowserClient = ReturnType<typeof createClient>;

export async function ensureAuthorId(
  sb: BrowserClient,
  ws: string,
  name: string,
): Promise<{ id: string | null; error?: string }> {
  const { data: ex } = await sb
    .from("authors")
    .select("id")
    .eq("workspace_id", ws)
    .eq("name", name)
    .maybeSingle();
  const hit = (ex as { id: string } | null)?.id;
  if (hit) return { id: hit };
  const { data: cr, error } = await sb
    .from("authors")
    .insert({ workspace_id: ws, name })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: (cr as { id: string } | null)?.id ?? null };
}

// Batch find-or-create for a document's author list. Same outcome as calling
// ensureAuthorId per name, but set-based: one SELECT for the names already
// present, one bulk INSERT for the rest (both chunked, so no unbounded
// `IN (...)`). Duplicate names in the input resolve once and share the id.
// Failure attribution stays per-name so each caller keeps its established
// policy (collect vs skip vs throw). A bulk INSERT that reports an error is
// NOT trusted blindly: a concurrent import may have won the race on some
// names (unique (workspace_id, name)), so the missing names are re-read and
// only genuinely-absent names report an error.
export async function ensureAuthorIds(
  sb: BrowserClient,
  ws: string,
  names: string[],
): Promise<Array<{ id: string | null; error?: string }>> {
  if (!names.length) return [];
  const unique = [...new Set(names)];
  const found = new Map<string, string>();
  const pull = async (list: string[]): Promise<void> => {
    for (const batch of chunkArray(list)) {
      const { data } = await sb
        .from("authors")
        .select("id, name")
        .eq("workspace_id", ws)
        .in("name", batch);
      for (const row of ((data ?? []) as Array<{ id: string; name: string }>)) {
        found.set(row.name, row.id);
      }
    }
  };
  await pull(unique);
  let missing = unique.filter((n) => !found.has(n));
  let insertError: string | null = null;
  if (missing.length) {
    const { error } = await sb
      .from("authors")
      .insert(missing.map((name) => ({ workspace_id: ws, name })))
      .select("id");
    if (error) insertError = error.message;
    // Re-read: rows the insert created are now visible, and so are rows a
    // concurrent writer created between our SELECT and INSERT.
    await pull(missing);
    missing = missing.filter((n) => !found.has(n));
  }
  return names.map((name) => {
    const id = found.get(name);
    if (id) return { id };
    return { id: null, error: insertError ?? `author "${name}": unresolved` };
  });
}
