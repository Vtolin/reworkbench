import { describe, expect, it, vi } from "vitest";
import {
  assessQuota,
  confirmBulkFiles,
  previewBulkFiles,
  MAX_BULK_FILES,
  WORKSPACE_STORAGE_QUOTA_BYTES,
  type BulkConfirmItem,
} from "./bulkIngest";
import type { ConfirmedDocument, IngestPreview } from "./ingest";

function file(name: string, size = 1000): File {
  return { name, size, type: "application/pdf" } as File;
}

function previewFor(name: string): IngestPreview {
  return {
    filename: name,
    fileHash: `hash-${name}`,
    fileSize: 1000,
    mimeType: "application/pdf",
    pageCount: 1,
    text: "x".repeat(5000),
    textSnippet: "xxx",
    extracted: { title: `Title ${name}`, year: null, doi: null, jurisdiction: null, document_type: "paper" },
    metadataProposal: {} as never,
    metadataCandidates: [],
    metadataError: null,
    offline: false,
    duplicates: [],
    isDuplicate: false,
    noText: false,
    extractionError: null,
    suggestedCollection: null,
    collectionReason: "",
    collectionConfidence: 0,
    decision: "confirm",
  };
}

function item(name: string, year: string | number = ""): BulkConfirmItem {
  return {
    file: file(name),
    preview: previewFor(name),
    edit: {
      title: `Title ${name}`,
      authors: "",
      year,
      doi: "",
      journal: null,
      jurisdiction: null,
      document_type: "paper",
      abstract: null,
      volume: null,
      issue: null,
      pages: null,
      publisher: null,
      collection_ids: [],
    },
    candidate: null,
  };
}

function doc(id: string): ConfirmedDocument {
  return { id, title: `Title ${id}`, stored_path: `ws/${id}.pdf`, ingestion_status: "ready", metadata_source: "local", metadata_confidence: null };
}

describe("batch cap", () => {
  it("exports a 10-file ceiling", () => {
    expect(MAX_BULK_FILES).toBe(10);
  });

  it("rejects empty and oversized batches before any work starts", async () => {
    await expect(previewBulkFiles([])).rejects.toThrow(/at least one file/);
    const tooMany = Array.from({ length: 11 }, (_, i) => file(`f${i}.pdf`));
    await expect(previewBulkFiles(tooMany)).rejects.toThrow(/max 10/);
    await expect(confirmBulkFiles([], { embedMode: "local" })).rejects.toThrow(/at least one file/);
  });
});

describe("previewBulkFiles", () => {
  it("collects per-file errors without losing the good previews", async () => {
    const previewFn = vi.fn(async (f: File) => {
      if (f.name === "bad.pdf") throw new Error("PDF parse failed");
      return previewFor(f.name);
    });
    const out = await previewBulkFiles([file("a.pdf"), file("bad.pdf"), file("c.pdf")], previewFn);
    expect(out).toHaveLength(3);
    expect(out[0]?.preview?.filename).toBe("a.pdf");
    expect(out[0]?.error).toBeNull();
    expect(out[1]?.preview).toBeNull();
    expect(out[1]?.error).toMatch(/PDF parse failed/);
    expect(out[2]?.preview?.filename).toBe("c.pdf");
    expect(previewFn).toHaveBeenCalledTimes(3);
  });

  it("reports progress per file", async () => {
    const seen: Array<[number, number]> = [];
    await previewBulkFiles([file("a.pdf"), file("b.pdf")], async (f) => previewFor(f.name), (d, t) => {
      seen.push([d, t]);
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });
});

describe("assessQuota", () => {
  const quota = WORKSPACE_STORAGE_QUOTA_BYTES;
  it("fits a small batch into an empty workspace", () => {
    const a = assessQuota(0, 10 * 1024 * 1024, quota);
    expect(a.ok).toBe(true);
    expect(a.message).toBeNull();
  });

  it("blocks a batch that would overflow the free-tier ceiling", () => {
    const a = assessQuota(quota - 100, 200, quota);
    expect(a.ok).toBe(false);
    expect(a.message).toContain("Batch too large for workspace storage");
  });

  it("treats an exactly-full workspace as overflow for any non-empty batch", () => {
    expect(assessQuota(quota, 1, quota).ok).toBe(false);
    expect(assessQuota(quota, 0, quota).ok).toBe(true);
  });
});

describe("confirmBulkFiles", () => {
  it("confirms serially in order and aggregates the summary", async () => {
    const order: string[] = [];
    const confirm = vi.fn(async (input: { preview: IngestPreview }) => {
      order.push(input.preview.filename);
      return { document: doc(input.preview.filename), indexingError: null };
    });
    const summary = await confirmBulkFiles([item("a.pdf"), item("b.pdf")], {
      embedMode: "local",
      confirmFn: confirm,
    });
    expect(order).toEqual(["a.pdf", "b.pdf"]);
    expect(summary).toMatchObject({ succeeded: 2, failed: 0 });
    expect(summary.results.map((r) => r.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(summary.results.every((r) => r.error === null)).toBe(true);
  });

  it("isolates a hard failure: the batch runs to completion", async () => {
    const confirm = vi.fn(async (input: { preview: IngestPreview }) => {
      if (input.preview.filename === "bad.pdf") throw new Error("storage down");
      return { document: doc(input.preview.filename), indexingError: null };
    });
    const summary = await confirmBulkFiles([item("a.pdf"), item("bad.pdf"), item("c.pdf")], {
      embedMode: "local",
      confirmFn: confirm,
    });
    expect(summary).toMatchObject({ succeeded: 2, failed: 1 });
    expect(summary.results[1]?.error).toMatch(/storage down/);
    expect(summary.results[1]?.document).toBeNull();
    expect(summary.results[2]?.document?.id).toBe("c.pdf");
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("surfaces per-file indexing warnings without failing the file", async () => {
    const confirm = vi.fn(async (input: { preview: IngestPreview }) => ({
      document: doc(input.preview.filename),
      indexingError: "embedding: embedder hiccup",
    }));
    const summary = await confirmBulkFiles([item("a.pdf")], { embedMode: "server", confirmFn: confirm });
    expect(summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(summary.results[0]?.indexing_error).toMatch(/embedder hiccup/);
  });

  it("blocks an invalid year per item without calling confirm", async () => {
    const confirm = vi.fn(async () => ({ document: doc("x"), indexingError: null }));
    const summary = await confirmBulkFiles([item("a.pdf", "99")], { embedMode: "local", confirmFn: confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(summary.results[0]?.error).toContain("Invalid year");
  });
});
