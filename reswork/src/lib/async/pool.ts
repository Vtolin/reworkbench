// Bounded-concurrency mapper that preserves input order.
// Extracted from the proven app/makalah/page.tsx implementation (Phase 10)
// so ingestion and UI share one primitive instead of two copies.
// Semantics: at most `limit` items in flight; results land at their input
// index; the first rejection stops new items from starting, in-flight items
// settle, then the first error is rethrown. Non-positive or non-finite
// limits behave as 1 (serial) rather than deadlocking or fanning out.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const workerCount = Math.min(
    Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1,
    items.length,
  );
  let next = 0;
  let firstError: unknown = null;
  let hasError = false;
  const worker = async (): Promise<void> => {
    while (true) {
      if (hasError) return;
      const idx = next++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        if (!hasError) {
          hasError = true;
          firstError = e;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hasError) throw firstError;
  return results;
}

// PostgREST `.in()` lists ride in the URL: keep them small enough to stay
// well under server/proxy URL limits at any cardinality. Pure, total, and
// order-preserving — the batching primitive for set-based `.in()` queries
// (hydrateDocs, loadDocs, author resolution) so callers never build an
// unbounded `IN (...)` clause.
export const IN_CHUNK_SIZE = 200;

export function chunkArray<T>(items: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const n = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : IN_CHUNK_SIZE;
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
