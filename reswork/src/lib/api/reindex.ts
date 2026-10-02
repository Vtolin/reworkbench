// Feature API: library reindex (embeddings rebuild).
// Thin delegates over lib/wb/reindex; behavior lives there.
import { listReindexTargets, reindexDocuments, type ReindexScope } from "../wb/reindex";
import { readInference } from "./inference";

export const reindexApi = {
  reindexTargets: () => listReindexTargets(),
  reindex: (
    scope: ReindexScope,
    docIds?: string[],
    onProgress?: (done: number, total: number) => void,
  ) => reindexDocuments({ scope, docIds, embedMode: readInference().embedMode, onProgress }),
};
