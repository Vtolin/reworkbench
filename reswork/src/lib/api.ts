// Browser API facade: the SAME method names the original UI calls
// (api.listDocuments, api.ask, api.compare, …), re-implemented against
// Supabase + browser-side inference. No FastAPI, no localhost server.
// Pages keep their exact UI; only id types changed (number → string uuid).
//
// Phase 5: this module is now a compatibility barrel. Implementations live
// in cohesive feature modules under lib/api/ (inference, library, search,
// research, makalah, citations, imports, related, projects); the assembled
// `api` object below preserves every key in its original order so all
// existing callers keep working unchanged.
import { libraryApi, documentFileUrl } from "./api/library";
import { searchApi } from "./api/search";
import { researchApi, researchTailApi } from "./api/research";
import { makalahApi } from "./api/makalah";
import { citationsApi } from "./api/citations";
import { importsApi } from "./api/imports";
import { relatedApi } from "./api/related";
import { projectsApi } from "./api/projects";
import { bulkApi } from "./api/bulk";
import { reindexApi } from "./api/reindex";
import { settingsApi } from "./api/inference";

export const api = {
  ...libraryApi,
  ...searchApi,
  ...researchApi,
  ...makalahApi,
  ...researchTailApi,
  ...citationsApi,
  ...importsApi,
  ...relatedApi,
  ...projectsApi,
  ...bulkApi,
  ...reindexApi,
  ...settingsApi,
  documentFileUrl,
};

// Compatibility re-exports (Phase 5): the public surface previously
// provided by this module keeps working for existing importers.
export { readInference, type StageSnapshot, type InferenceSnapshot } from "./api/inference";
export type { AskBody } from "./api/research";
