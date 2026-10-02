import { describe, expect, it, vi, beforeEach } from "vitest";

// Full-scope reindex (delete + re-insert vectors) with a mocked backend.
// Missing-scope is a thin delegate to reembedMissingEmbeddings (covered in
// ingestResilience.test.ts); here we pin the full path: delete-then-insert
// shape (never UPDATE — admin-only RLS), idempotent refill, and failure
// visibility.
const S = vi.hoisted(() => ({
  docIds: ["doc1"] as string[],
  chunks: [
    { id: "c1", content: "aaa" },
    { id: "c2", content: "bbb" },
  ] as Array<{ id: string; content: string }>,
  deletedBatches: [] as string[][],
  inserted: [] as unknown[][],
  updates: [] as Array<Record<string, unknown>>,
  deleteError: false,
  insertError: false,
  embedFail: false,
  docStatus: "ready",
}));

vi.mock("@/lib/ai/ollama", () => ({
  OllamaProvider: class {
    embed = async (text: string): Promise<number[]> => {
      if (S.embedFail) throw new Error("embedder down");
      void text;
      return new Array(768).fill(0.1);
    };
  },
}));

function membersChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => ({ data: { workspace_id: "ws1" }, error: null });
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      if (table === "workspace_members") return membersChain();
      if (table === "document_chunks") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => Promise.resolve({ data: S.chunks, error: null });
        return chain;
      }
      if (table === "document_embeddings") {
        return {
          delete: () => ({
            in: async (_col: string, batch: string[]) => {
              S.deletedBatches.push(batch);
              return S.deleteError ? { error: { message: "delete boom" } } : { error: null };
            },
          }),
          insert: (rows: unknown[]) => {
            S.inserted.push(rows);
            return S.insertError ? { error: { message: "insert boom" } } : { error: null };
          },
        };
      }
      // documents: select chain serves both the id listing
      // (.eq.order.limit) and the status re-read (.eq.maybeSingle).
      const listRows = () => Promise.resolve({ data: S.docIds.map((id) => ({ id })), error: null });
      const docChain: Record<string, unknown> = {};
      docChain.eq = () => docChain;
      docChain.order = () => docChain;
      docChain.limit = () => listRows();
      docChain.maybeSingle = async () => ({ data: { ingestion_status: S.docStatus }, error: null });
      return {
        select: () => docChain,
        update: (payload: Record<string, unknown>) => {
          S.updates.push(payload);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc: async () => ({ data: [], error: null }),
  }),
}));

// documents.select is shared between listReindexTargets and the status
// re-read; disambiguate by adding maybeSingle to the same chain shape.
beforeEach(() => {
  S.docIds = ["doc1"];
  S.chunks = [
    { id: "c1", content: "aaa" },
    { id: "c2", content: "bbb" },
  ];
  S.deletedBatches = [];
  S.inserted = [];
  S.updates = [];
  S.deleteError = false;
  S.insertError = false;
  S.embedFail = false;
  S.docStatus = "ready";
});

import { reindexDocuments } from "./reindex";

describe("reindex full scope", () => {
  it("deletes then re-inserts every chunk vector (never updates)", async () => {
    const summary = await reindexDocuments({ scope: "full", docIds: ["doc1"], embedMode: "local" });
    expect(summary).toMatchObject({ docsScanned: 1, docsFixed: 1, chunksEmbedded: 2, chunksDeleted: 2 });
    expect(summary.warnings).toEqual([]);
    // Delete ran for the chunk batch…
    expect(S.deletedBatches).toEqual([["c1", "c2"]]);
    // …and one bulk insert carried both fresh vectors.
    expect(S.inserted).toHaveLength(1);
    expect((S.inserted[0] as Array<{ chunk_id: string }>).map((r) => r.chunk_id).sort()).toEqual(["c1", "c2"]);
    // No status flip needed for a healthy doc.
    expect(S.updates).toEqual([]);
  });

  it("resolves targets from the workspace when no docIds are given", async () => {
    S.docIds = ["doc1", "doc2"];
    const summary = await reindexDocuments({ scope: "full", embedMode: "local" });
    expect(summary.docsScanned).toBe(2);
    expect(summary.docsFixed).toBe(2);
    expect(summary.chunksEmbedded).toBe(4);
  });

  it("stops a document on delete failure and warns (vectors untouched)", async () => {
    S.deleteError = true;
    const summary = await reindexDocuments({ scope: "full", docIds: ["doc1"], embedMode: "local" });
    expect(summary.docsFixed).toBe(0);
    expect(summary.chunksEmbedded).toBe(0);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/not cleared/);
    expect(S.inserted).toEqual([]);
  });

  it("marks the row errored when embedding fails after the clear", async () => {
    S.embedFail = true;
    const summary = await reindexDocuments({ scope: "full", docIds: ["doc1"], embedMode: "local" });
    expect(summary.docsFixed).toBe(0);
    expect(summary.warnings.some((w) => w.includes("embed failed"))).toBe(true);
    const marks = S.updates.filter((u) => u.ingestion_status === "error");
    expect(marks).toHaveLength(1);
  });

  it("marks the row errored when the refill insert fails", async () => {
    S.insertError = true;
    const summary = await reindexDocuments({ scope: "full", docIds: ["doc1"], embedMode: "local" });
    expect(summary.docsFixed).toBe(0);
    expect(summary.warnings.some((w) => w.includes("not stored"))).toBe(true);
    expect(S.updates.filter((u) => u.ingestion_status === "error")).toHaveLength(1);
  });

  it("warns when a document has no chunks (re-upload required)", async () => {
    S.chunks = [];
    const summary = await reindexDocuments({ scope: "full", docIds: ["doc1"], embedMode: "local" });
    expect(summary.docsFixed).toBe(0);
    expect(summary.warnings.some((w) => w.includes("re-upload required"))).toBe(true);
    expect(S.inserted).toEqual([]);
  });
});

describe("reindex missing scope", () => {
  it("delegates to the idempotent missing-vectors path", async () => {
    // Empty backend: nothing to scan, clean summary, no full-path writes.
    S.chunks = [];
    const summary = await reindexDocuments({ scope: "missing", embedMode: "local" });
    expect(summary.warnings).toEqual([]);
    expect(summary.chunksDeleted).toBe(0);
    expect(S.inserted).toEqual([]);
  });
});
