import { describe, expect, it, vi } from "vitest";
import { executeIngestFlow, validateUploadYear } from "./ingestRunner";
import type { ConfirmedDocument, ConfirmInput, IngestPreview } from "./ingest";

function preview(): IngestPreview {
  return { fileHash: "h" } as IngestPreview;
}

function edit(overrides: Record<string, unknown> = {}) {
  return {
    title: "T",
    authors: "A B, C D",
    year: "2024",
    doi: "10.1/x",
    journal: "J",
    jurisdiction: null,
    document_type: null,
    abstract: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    collection_ids: ["c1"],
    ...overrides,
  };
}

function events() {
  return {
    phase: vi.fn(),
    done: vi.fn(),
    failed: vi.fn(),
  };
}

describe("validateUploadYear", () => {
  it("accepts empty and valid 4-digit years", () => {
    expect(validateUploadYear("")).toEqual({ ok: true, year: null });
    expect(validateUploadYear("2024")).toEqual({ ok: true, year: 2024 });
    expect(validateUploadYear("1000")).toEqual({ ok: true, year: 1000 });
  });

  it("rejects non-years with the exact UploadFlow message", () => {
    for (const bad of ["24", "abcd", "99", "2200", "2024.5"]) {
      const out = validateUploadYear(bad);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain('4-digit year 1000–2100');
    }
  });
});

describe("executeIngestFlow", () => {
  const file = { name: "p.pdf", size: 10 } as File;

  it("confirms with assembled input and reports the result", async () => {
    const document: ConfirmedDocument = {
      id: "d1",
      title: "T",
      stored_path: "ws/h.pdf",
      ingestion_status: "ready",
      metadata_source: "openalex",
      metadata_confidence: 0.9,
    };
    const confirm = vi.fn(async (_input: ConfirmInput) => ({ document, indexingError: null }));
    const ev = events();
    await executeIngestFlow(
      confirm,
      {
        file,
        preview: preview(),
        edit: edit(),
        candidate: { source: "openalex", confidence: 0.9, extras: { k: 1 } },
        embedMode: "local",
      },
      ev,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    const input = confirm.mock.calls[0]?.[0] as unknown as {
      authors: string[];
      year: number | null;
      metadataSource: string;
    };
    expect(input.authors).toEqual(["A B", "C D"]);
    expect(input.year).toBe(2024);
    expect(input.metadataSource).toBe("openalex");
    expect(ev.done).toHaveBeenCalledWith({ document, indexing_error: null });
    expect(ev.failed).not.toHaveBeenCalled();
    expect(ev.phase.mock.calls[0]?.[0]).toContain("Uploading");
    expect(ev.phase.mock.calls.at(-1)?.[0]).toBe("");
  });

  it("blocks invalid years before touching confirm", async () => {
    const confirm = vi.fn();
    const ev = events();
    await executeIngestFlow(
      confirm,
      { file, preview: preview(), edit: edit({ year: "99" }), candidate: null, embedMode: "local" },
      ev,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(ev.failed).toHaveBeenCalledWith(expect.stringContaining("Invalid year"));
    expect(ev.done).not.toHaveBeenCalled();
  });

  it("surfaces confirm failures as messages", async () => {
    const confirm = vi.fn(async () => {
      throw new Error("storage down");
    });
    const ev = events();
    await executeIngestFlow(
      confirm,
      { file, preview: preview(), edit: edit(), candidate: null, embedMode: "server" },
      ev,
    );
    expect(ev.failed).toHaveBeenCalledWith("storage down");
    expect(ev.done).not.toHaveBeenCalled();
  });
});
