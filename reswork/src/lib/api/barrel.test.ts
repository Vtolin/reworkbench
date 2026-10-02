import { describe, expect, it } from "vitest";
import { api, readInference } from "../api";
import { readInference as readInferenceFromModule } from "./inference";

// Migration lock (Phase 5): the barrel must expose every facade method in
// its original order. Derived from git HEAD:src/lib/api.ts (pre-split).
// Any dropped, renamed, or reordered key fails here.
const EXPECTED_KEYS = [
  // library
  "listDocuments", "getDocument", "updateDocument", "deleteDocument",
  "setCollections", "setTags", "collections", "createCollection",
  "tags", "createTag", "stats", "health",
  // search
  "search", "searches", "createSearch", "deleteSearch", "runSearch",
  // research
  "ask", "askStream", "clearMemory", "memoryStatus", "compare",
  "summarize", "summarizeStream", "summarizeExport", "matrix",
  "matrixExport", "synthesis",
  // makalah
  "makalahSources", "makalahOutline", "makalahRetrieve", "makalahSection",
  "makalahReferences", "makalahClaimCheck",
  // research continued
  "extract", "legalAnalysis", "trail",
  // citations
  "citationStyles", "citationStyleDefault", "citationStyleCustom",
  "citationStyleFetch", "citations",
  // imports
  "importRefs", "importFile", "exportRefs", "exportBibliography",
  // related
  "related", "references", "annotations", "createAnnotation",
  "patchAnnotation", "legalRefresh", "citedCases", "casesCiting",
  // projects
  "projects", "createProject", "getProject", "deleteProject",
  "addProjectEvidence", "projectClaims", "createClaim", "deleteClaim",
  "claimAddCitation",
  // bulk upload (appended after projects; original order above untouched)
  "maxBulkFiles", "quotaBytes", "previewBulk", "workspaceUsage",
  "assessQuota", "confirmBulk",
  // reindex (appended after bulk)
  "reindexTargets", "reindex",
  // settings
  "config", "updateConfig", "settings", "updateSettings",
  "documentFileUrl",
];

describe("api barrel", () => {
  it("exposes every facade method in original order", () => {
    expect(Object.keys(api)).toEqual(EXPECTED_KEYS);
  });

  it("re-exports the inference snapshot reader unchanged", () => {
    expect(readInference).toBe(readInferenceFromModule);
    // Node has no localStorage; the reader fails closed to defaults.
    expect(readInference().provider).toBe("ollama");
  });
});
