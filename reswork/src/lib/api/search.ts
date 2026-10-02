// Feature API: search + saved searches.
// Thin delegates over lib/wb/search. Extracted verbatim from lib/api.ts
// (Phase 5); behavior unchanged.
import { groupedSearch, listSavedSearches, createSavedSearch, deleteSavedSearch } from "../wb/search";
import { readInference } from "./inference";

export const searchApi = {
  search: (q: string) => groupedSearch(q, readInference().embedMode),
  searches: () => listSavedSearches(),
  createSearch: (body: { name: string; query: string }) => createSavedSearch(body.name, body.query),
  deleteSearch: (id: string) => deleteSavedSearch(id),
  runSearch: async (id: string) => {
    const saved = await listSavedSearches();
    const s = saved.find((x) => x.id === id);
    if (!s) throw new Error("Saved search not found");
    return groupedSearch(s.query, readInference().embedMode);
  },
};
