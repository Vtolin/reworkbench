import { describe, expect, it, vi, beforeEach } from "vitest";

// Ingest resilience (Phase 4 acceptance): a mid-ingest embed failure must
// leave a consistent, visible, recoverable state —
//   consistent: chunks persisted (FTS intact), NO half-written embeddings
//     (bulk insert never ran), storage object kept (row exists);
//   visible: documents row marked ingestion_status=error with a reason;
//   recoverable: idempotent re-embed fills exactly the missing vectors and
//     flips the row back to ready.
const S = vi.hoisted(() => ({
  calls: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  embeddingsInserts: [] as unknown[][],
  embedCalls: [] as string[],
  embedFailMode: "second-on" as "second-on" | "always" | "off",
  docInsertError: false,
  sourcesError: false,
  statusForCheck: "error",
  reembedDocs: [] as Array<Record<string, unknown>>,
  healthRows: [] as Array<Record<string, unknown>>,
  reembedChunks: [] as Array<{ id: string; content: string }>,
  existingEmbeddings: [] as string[],
  removedPaths: [] as string[],
  storageObjects: ["keep.pdf"],
  docStoragePaths: ["ws1/keep.pdf"],
  sweepResult: [{ path: "ws1/gone.pdf" }],
}));

vi.mock("@/lib/ai/ollama", () => ({
  OllamaProvider: class {
    embed = async (text: string): Promise<number[]> => {
      S.embedCalls.push(text);
      if (S.embedFailMode === "always") throw new Error("embedder down");
      if (S.embedFailMode === "second-on" && S.embedCalls.length >= 2) {
        throw new Error("embedder died mid-ingest");
      }
      return new Array(768).fill(0.1);
    };
  },
}));

function documentsChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => ({ data: S.reembedDocs, error: null });
  chain.limit = () => ({ data: S.docStoragePaths.map((p) => ({ storage_path: p })), error: null });
  chain.single = async () => ({ data: { id: "doc1", title: "T", ingestion_status: "error" }, error: null });
  chain.maybeSingle = async () => ({ data: { ingestion_status: S.statusForCheck }, error: null });
  return chain;
}

function membersChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => ({ data: { workspace_id: "ws1" }, error: null });
  return chain;
}

function chunksChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: S.reembedChunks, error: null });
  return chain;
}

function embeddingsChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = () => chain;
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: S.existingEmbeddings.map((id) => ({ chunk_id: id })), error: null });
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    storage: {
      from: () => ({
        upload: async () => {
          S.calls.push("storage:upload");
          return { error: null };
        },
        remove: async (paths: string[]) => {
          S.calls.push(`storage:remove:${paths.join(",")}`);
          S.removedPaths.push(...paths);
          return { data: S.sweepResult, error: null };
        },
        list: async () => {
          S.calls.push("storage:list");
          return { data: S.storageObjects.map((name) => ({ name })), error: null };
        },
      }),
    },
    from: (table: string) => {
      if (table === "workspace_members") return membersChain();
      if (table === "document_chunks") {
        return {
          ...chunksChain(),
          insert: (rows: Array<{ content: string }>) => {
            S.calls.push(`insert:chunks:${rows.length}`);
            return {
              select: () => ({
                data: rows.map((r, i) => ({ id: `c${i + 1}`, content: r.content })),
                error: null,
              }),
            };
          },
        };
      }
      if (table === "document_embeddings") {
        return {
          ...embeddingsChain(),
          insert: (rows: unknown[]) => {
            S.calls.push(`insert:embeddings:${rows.length}`);
            S.embeddingsInserts.push(rows);
            return { error: null };
          },
        };
      }
      if (table === "sources") {
        return { insert: () => ({ error: S.sourcesError ? { message: "sources row boom" } : null }) };
      }
      // documents
      return {
        ...documentsChain(),
        insert: () => ({
          select: () => ({
            single: async () => {
              S.calls.push("insert:documents");
              return S.docInsertError
                ? { data: null, error: { message: "doc boom" } }
                : { data: { id: "doc1", title: "T" }, error: null };
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          S.calls.push(`update:documents:${JSON.stringify(payload)}`);
          S.updates.push(payload);
          return { eq: () => ({ error: null }) };
        },
      };
    },
    rpc: async (fn: string) => {
      S.calls.push(`rpc:${fn}`);
      return { data: S.healthRows, error: null };
    },
  }),
}));

import {
  computeMissingEmbeddings,
  confirmIngest,
  listOrphanStoragePaths,
  reembedMissingEmbeddings,
  sweepOrphanStorage,
  type ConfirmInput,
} from "./ingest";

function confirmInput(): ConfirmInput {
  return {
    file: { name: "paper.pdf", size: 10_000, type: "application/pdf" } as File,
    preview: {
      filename: "paper.pdf",
      fileHash: "abc123",
      fileSize: 10_000,
      mimeType: "application/pdf",
      pageCount: 2,
      text: "x".repeat(10_000),
      textSnippet: "xxx",
      extracted: { title: "T", year: null, doi: null, jurisdiction: null, document_type: "paper" },
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
    },
    title: "T",
    authors: [],
    year: null,
    doi: null,
    journal: null,
    jurisdiction: null,
    document_type: "paper",
    abstract: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    citationMetadata: {},
    metadataSource: "test",
    metadataConfidence: null,
    collectionIds: [],
    embedMode: "local",
  };
}

beforeEach(() => {
  S.calls = [];
  S.updates = [];
  S.embeddingsInserts = [];
  S.embedCalls = [];
  S.embedFailMode = "second-on";
  S.docInsertError = false;
  S.sourcesError = false;
  S.statusForCheck = "error";
  S.reembedDocs = [];
  S.healthRows = [];
  S.reembedChunks = [];
  S.existingEmbeddings = [];
  S.removedPaths = [];
  S.storageObjects = ["keep.pdf"];
  S.docStoragePaths = ["ws1/keep.pdf"];
});

describe("mid-ingest embed failure", () => {
  it("leaves consistent + visible state: chunks kept, no partial vectors, row errored, storage kept", async () => {
    const { indexingError } = await confirmIngest(confirmInput());
    // Visible: reason surfaced to the caller…
    expect(indexingError).toMatch(/embedder died mid-ingest/);
    // …and persisted on the row exactly once (embed catch marked it; the
    // link-error backstop saw error and stood down).
    const errorMarks = S.updates.filter((u) => u.ingestion_status === "error");
    expect(errorMarks.length).toBe(1);
    expect(String(errorMarks[0].ingestion_error)).toMatch(/embedder died mid-ingest/);
    // Consistent: all chunks stored (FTS intact)…
    expect(S.calls).toContain("insert:chunks:3");
    expect(S.embedCalls.length).toBe(3);
    // …but the bulk embeddings insert never ran (no half-embedded rows)…
    expect(S.embeddingsInserts.length).toBe(0);
    // …and the storage object is kept: the row exists, so recovery (below)
    // reuses it instead of orphaning it.
    expect(S.removedPaths).toEqual([]);
  });

  it("recovers via idempotent re-embed: fills exactly the missing vectors, flips to ready", async () => {
    await confirmIngest(confirmInput());
    expect(S.embeddingsInserts.length).toBe(0);
    // Embedder healed; the failed doc has 3 chunks, 0 vectors.
    S.embedFailMode = "off";
    S.embedCalls = [];
    S.reembedDocs = [
      { id: "doc1", title: "T", ingestion_status: "error", ingestion_error: "embedder died" },
    ];
    S.reembedChunks = [
      { id: "c1", content: "aaa" },
      { id: "c2", content: "bbb" },
      { id: "c3", content: "ccc" },
    ];
    S.existingEmbeddings = [];
    const summary = await reembedMissingEmbeddings({ embedMode: "local", docIds: ["doc1"] });
    expect(summary).toMatchObject({ docsScanned: 1, docsFixed: 1, chunksEmbedded: 3, chunksSkipped: 0 });
    expect(summary.warnings).toEqual([]);
    expect(S.embeddingsInserts.length).toBe(1);
    expect((S.embeddingsInserts[0] as Array<{ chunk_id: string }>).map((r) => r.chunk_id).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    const flips = S.updates.filter((u) => u.ingestion_status === "ready");
    expect(flips.length).toBe(1);
  });

  it("skips chunks that already have embeddings (second run is a no-op)", async () => {
    // Full-scan path via the ingest_health RPC (what the Admin button uses).
    S.healthRows = [{ document_id: "doc1", title: "T", ingestion_status: "ready", ingestion_error: null }];
    S.reembedChunks = [
      { id: "c1", content: "aaa" },
      { id: "c2", content: "bbb" },
    ];
    S.existingEmbeddings = ["c1", "c2"];
    const summary = await reembedMissingEmbeddings({ embedMode: "local" });
    expect(summary).toMatchObject({ chunksEmbedded: 0, chunksSkipped: 2, docsFixed: 0 });
    expect(S.embeddingsInserts.length).toBe(0);
  });
});

describe("link-only failure visibility", () => {
  it("persists the reason when links fail but embeddings succeed", async () => {
    S.embedFailMode = "off";
    S.sourcesError = true;
    S.statusForCheck = "ready";
    const { indexingError } = await confirmIngest(confirmInput());
    expect(indexingError).toMatch(/sources row/);
    // Vectors landed…
    expect(S.embeddingsInserts.length).toBe(1);
    // …yet the row is still marked error with the link reason (Admin sees it).
    const marks = S.updates.filter((u) => u.ingestion_status === "error");
    expect(marks.length).toBe(1);
    expect(String(marks[0].ingestion_error)).toMatch(/sources row/);
  });
});

describe("document-insert failure hygiene", () => {
  it("deletes the uploaded object when no row exists, then throws", async () => {
    S.docInsertError = true;
    await expect(confirmIngest(confirmInput())).rejects.toThrow(/doc boom/);
    expect(S.removedPaths).toEqual(["ws1/abc123.pdf"]);
    expect(S.updates.length).toBe(0);
  });
});

describe("computeMissingEmbeddings", () => {
  it("diffs ids, tolerating dupes and nulls", () => {
    expect(computeMissingEmbeddings(["a", "b", "c"], ["b", null, "b"])).toEqual(["a", "c"]);
    expect(computeMissingEmbeddings([], [])).toEqual([]);
  });
});

describe("orphan sweep", () => {
  it("lists storage objects with no documents row, then deletes them", async () => {
    S.storageObjects = ["keep.pdf", "gone.pdf"];
    S.docStoragePaths = ["ws1/keep.pdf"];
    const scan = await listOrphanStoragePaths();
    expect(scan.orphans).toEqual(["ws1/gone.pdf"]);
    expect(scan.truncated).toBe(false);
    const sweep = await sweepOrphanStorage(scan.orphans);
    expect(sweep.removed).toEqual(["ws1/gone.pdf"]);
    expect(sweep.errors).toEqual([]);
    expect(S.removedPaths).toEqual(["ws1/gone.pdf"]);
  });
});
