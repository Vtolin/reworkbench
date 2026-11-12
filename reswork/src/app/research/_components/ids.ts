/** Add/remove an id in a multi-select array (stable order, no duplicates). */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
