import { describe, expect, it } from "vitest";
import type { HydratedDoc } from "./library";
import { groupDuplicateCandidates, parseIdentifierInput } from "./quickAddAndMerge";

function fakeDoc(overrides: Partial<HydratedDoc>): HydratedDoc {
  return {
    id: "doc-1",
    title: "Sample Paper",
    original_filename: "sample.pdf",
    created_at: "2026-01-01T00:00:00Z",
    storage_path: null,
    file_hash: null,
    file_size: null,
    mime_type: null,
    doi: null,
    year: 2024,
    journal: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    abstract: null,
    jurisdiction: null,
    document_type: "journal",
    page_count: null,
    ingestion_status: "metadata_only",
    ingestion_error: null,
    metadata_json: {},
    citation_metadata: {},
    metadata_source: null,
    metadata_fetched_at: null,
    metadata_confidence: null,
    metadata_verified: false,
    status: "approved",
    authors: [],
    collections: [],
    tags: [],
    ...overrides,
  };
}

describe("parseIdentifierInput", () => {
  it("recognizes DOI URLs, bare DOIs, ISBNs, PMIDs, and fallback titles", () => {
    expect(parseIdentifierInput("https://doi.org/10.1038/s41586-024-00001")).toEqual({
      doi: "10.1038/s41586-024-00001",
    });
    expect(parseIdentifierInput("10.1145/3586183.3606763")).toEqual({
      doi: "10.1145/3586183.3606763",
    });
    expect(parseIdentifierInput("978-0-262-04682-4")).toEqual({
      isbn: "9780262046824",
    });
    expect(parseIdentifierInput("PMID: 38291045")).toEqual({
      pmid: "38291045",
    });
    expect(parseIdentifierInput("Constitutional AI in Indonesia")).toEqual({
      title: "Constitutional AI in Indonesia",
    });
  });
});

describe("groupDuplicateCandidates", () => {
  it("detects exact DOI and fuzzy title duplicate pairs", () => {
    const docs = [
      fakeDoc({ id: "a", title: "Legal Retrieval Benchmarks", doi: "10.1000/abc" }),
      fakeDoc({ id: "b", title: "Completely Different Name", doi: "https://doi.org/10.1000/abc" }),
      fakeDoc({ id: "c", title: "Constitutional Court Review of Digital Privacy in Indonesia" }),
      fakeDoc({ id: "d", title: "Constitutional Court Review of Digital Privacy Indonesia" }),
    ];

    const pairs = groupDuplicateCandidates(docs);
    expect(pairs.some((p) => p.reason === "doi" && p.left.id === "a" && p.right.id === "b")).toBe(true);
    expect(pairs.some((p) => (p.reason === "title_fuzzy" || p.reason === "title_exact") && p.left.id === "c" && p.right.id === "d")).toBe(true);
  });
});
