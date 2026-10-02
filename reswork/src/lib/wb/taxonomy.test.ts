import { describe, expect, it } from "vitest";
import { ensureAuthorIds } from "./taxonomy";

// Minimal PostgREST-chain mock: supports exactly the two shapes taxonomy.ts
// uses — select().eq().in() (awaited) and insert().select() (awaited).
function makeSb(opts: {
  seed?: Array<[string, string]>; // [name, id]
  failInsert?: string;
  raceInsert?: string[]; // names a concurrent writer creates despite our error
}) {
  const store = new Map<string, string>(opts.seed ?? []);
  let next = 0;
  const calls: string[] = [];
  const sb = {
    calls,
    from() {
      return {
        select(_cols: string) {
          return {
            eq(_c: string, _v: string) {
              return {
                in: async (_c2: string, list: string[]) => {
                  calls.push(`select:in(${list.length})`);
                  return {
                    data: list
                      .filter((n) => store.has(n))
                      .map((n) => ({ id: store.get(n), name: n })),
                    error: null,
                  };
                },
              };
            },
          };
        },
        insert(rows: Array<{ name: string }>) {
          return {
            select: async (_c: string) => {
              calls.push(`insert(${rows.length})`);
              if (opts.failInsert) {
                for (const n of opts.raceInsert ?? []) {
                  if (!store.has(n)) store.set(n, `race-${n}`);
                }
                return { data: null, error: { message: opts.failInsert } };
              }
              for (const r of rows) {
                if (!store.has(r.name)) store.set(r.name, `id-${next++}`);
              }
              return {
                data: rows.map((r) => ({ id: store.get(r.name) })),
                error: null,
              };
            },
          };
        },
      };
    },
  };
  // PostgREST-chain shape only; cast through unknown (no `any`). `calls`
  // stays accessible for query-count assertions.
  return { client: sb as unknown as Parameters<typeof ensureAuthorIds>[0], calls };
}

describe("ensureAuthorIds", () => {
  it("returns empty without querying for empty input", async () => {
    const { client, calls } = makeSb({});
    expect(await ensureAuthorIds(client, "ws", [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("resolves existing names with a single SELECT and no INSERT", async () => {
    const { client, calls } = makeSb({ seed: [["Ayu", "a1"], ["Budi", "b2"]] });
    const out = await ensureAuthorIds(client, "ws", ["Ayu", "Budi"]);
    expect(out).toEqual([{ id: "a1" }, { id: "b2" }]);
    expect(calls).toEqual(["select:in(2)"]);
  });

  it("bulk-inserts missing names and dedupes repeated input names", async () => {
    const { client, calls } = makeSb({ seed: [["Ayu", "a1"]] });
    const out = await ensureAuthorIds(client, "ws", ["Ayu", "Citra", "Citra", "Dewi"]);
    expect(out[0]).toEqual({ id: "a1" });
    expect(out[1].id).toBe(out[2].id);
    expect(out[1].id).toBeTruthy();
    expect(out[3].id).toBeTruthy();
    expect(out[1].id).not.toBe(out[3].id);
    // One SELECT for all unique names, one bulk INSERT for the missing two.
    expect(calls).toEqual(["select:in(3)", "insert(2)", "select:in(2)"]);
  });

  it("recovers when a concurrent writer wins the race (insert errors, reread hits)", async () => {
    const { client } = makeSb({ seed: [], failInsert: "duplicate key", raceInsert: ["Citra"] });
    const out = await ensureAuthorIds(client, "ws", ["Citra"]);
    expect(out).toEqual([{ id: "race-Citra" }]);
  });

  it("attributes a genuine insert failure per missing name", async () => {
    const { client } = makeSb({ seed: [], failInsert: "connection reset" });
    const out = await ensureAuthorIds(client, "ws", ["Citra", "Dewi"]);
    expect(out).toEqual([
      { id: null, error: "connection reset" },
      { id: null, error: "connection reset" },
    ]);
  });
});
