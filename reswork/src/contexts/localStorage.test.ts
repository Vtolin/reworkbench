import { describe, expect, it } from "vitest";
import {
  isQuotaError,
  loadDocList,
  persistErrorFor,
  readJsonDoc,
  writeJsonDoc,
  type StorageLike,
} from "./localStorage";
import { sanitizeInferenceSettings } from "./InferenceContext";
import { blankSnapshot, normalize } from "./MakalahContext";

function memStore(initial: Record<string, string> = {}): StorageLike & { drop: () => void } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    drop: () => map.clear(),
  };
}

function throwingStore(mode: "quota" | "generic"): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      if (mode === "quota") throw new DOMException("Quota exceeded", "QuotaExceededError");
      throw new Error("denied");
    },
    removeItem: () => {},
  };
}

const MSGS = { quotaMessage: "QUOTA", failureMessage: "FAIL" };

describe("readJsonDoc", () => {
  it("returns undefined for missing, corrupt, or absent storage", () => {
    expect(readJsonDoc(memStore(), "k")).toBeUndefined();
    expect(readJsonDoc(memStore({ k: "{nope" }), "k")).toBeUndefined();
    expect(readJsonDoc(null, "k")).toBeUndefined();
    expect(readJsonDoc(memStore({ k: '{"a":1}' }), "k")).toEqual({ a: 1 });
  });
});

describe("writeJsonDoc + isQuotaError", () => {
  it("writes normally", () => {
    const store = memStore();
    expect(writeJsonDoc(store, "k", { a: 1 })).toEqual({ ok: true, quota: false });
    expect(store.getItem("k")).toBe('{"a":1}');
  });

  it("detects quota failures (name- and message-based)", () => {
    expect(writeJsonDoc(throwingStore("quota"), "k", {})).toEqual({ ok: false, quota: true });
    expect(isQuotaError(new DOMException("x", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new Error("storage quota exceeded"))).toBe(true);
    expect(isQuotaError(new Error("denied"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it("maps outcomes to the persistError surface", () => {
    expect(persistErrorFor({ ok: true, quota: false }, MSGS)).toBeNull();
    expect(persistErrorFor({ ok: false, quota: true }, MSGS)).toBe("QUOTA");
    expect(persistErrorFor({ ok: false, quota: false }, MSGS)).toBe("FAIL");
  });
});

interface Doc {
  id: string;
}

describe("loadDocList", () => {
  const base = {
    parseItems: (raw: unknown) => (Array.isArray(raw) ? (raw as Doc[]) : []),
    getId: (d: Doc) => d.id,
    freshItem: () => ({ id: "fresh" }),
  };

  it("loads items and keeps a valid active id", () => {
    const out = loadDocList({
      ...base,
      store: memStore({ items: JSON.stringify([{ id: "a" }, { id: "b" }]), active: "b" }),
      itemsKey: "items",
      activeKey: "active",
    });
    expect(out).toEqual({ items: [{ id: "a" }, { id: "b" }], activeId: "b" });
  });

  it("repairs an unknown active id to the first item", () => {
    const out = loadDocList({
      ...base,
      store: memStore({ items: JSON.stringify([{ id: "a" }]), active: "ghost" }),
      itemsKey: "items",
      activeKey: "active",
    });
    expect(out.activeId).toBe("a");
  });

  it("migrates legacy keys, then falls back to fresh", () => {
    const migrated = loadDocList({
      ...base,
      store: memStore({ legacy: JSON.stringify([{ id: "old" }]) }),
      itemsKey: "items",
      activeKey: "active",
      migrate: (store) => {
        const raw = store?.getItem("legacy") ?? null;
        return raw ? (JSON.parse(raw) as Doc[]) : [];
      },
    });
    expect(migrated).toEqual({ items: [{ id: "old" }], activeId: "old" });

    const fresh = loadDocList({ ...base, store: memStore(), itemsKey: "items", activeKey: "active" });
    expect(fresh).toEqual({ items: [{ id: "fresh" }], activeId: "fresh" });
  });

  it("applies sort when provided", () => {
    const out = loadDocList({
      ...base,
      store: memStore({ items: JSON.stringify([{ id: "a" }, { id: "b" }]) }),
      itemsKey: "items",
      activeKey: "active",
      sort: (items) => [...items].reverse(),
    });
    expect(out.items.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("honors the corrupt-entry fallback per caller (empty vs fresh)", () => {
    const opts = {
      ...base,
      // A non-matching active id forces validation over every entry, so the
      // null entry throws during getId (exactly the historical crash shape;
      // a matching id would short-circuit .some before reaching it).
      store: memStore({ items: JSON.stringify([{ id: "a" }, null]), active: "ghost" }),
      itemsKey: "items",
      activeKey: "active",
    };
    expect(loadDocList({ ...opts, onParseError: "empty" })).toEqual({ items: [], activeId: null });
    expect(loadDocList({ ...opts, onParseError: "fresh" })).toEqual({
      items: [{ id: "fresh" }],
      activeId: "fresh",
    });
  });
});

describe("makalah checkpoints (resume after a closed tab)", () => {
  it("resets in-flight sections to idle, keeps finished work", () => {
    const snap = blankSnapshot();
    const out = normalize({
      ...snap,
      id: "d",
      createdAt: 1,
      updatedAt: 2,
      secs: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a: { status: "generating", passages: [{ source_id: "s" }], output: null, error: null, integrity: null, claims: null } as any,
        b: {
          status: "ok",
          passages: [],
          output: { paragraphs: [], gaps: "" },
          error: null,
          integrity: { total: 1, valid: 1, badIds: [], badPages: [] },
          claims: [{ verdict: "supported", reason: "r" }],
        },
      },
    });
    expect(out.secs.a.status).toBe("idle");
    expect(out.secs.a.passages).toEqual([{ source_id: "s" }]);
    expect(out.secs.b.status).toBe("ok");
    expect(out.secs.b.claims).toEqual([{ verdict: "supported", reason: "r" }]);
  });

  it("repairs malformed drafts to safe defaults", () => {
    const out = normalize({ id: "d", createdAt: 1, updatedAt: 2 } as never);
    expect(out.outline).toEqual([]);
    expect(out.step).toBe(1);
    expect(out.secs).toEqual({});
  });
});

describe("sanitizeInferenceSettings", () => {
  const defaults = {
    provider: "ollama",
    cloudProvider: "openai",
    makalahThinkLevel: "low",
    embedMode: "local",
    numCtx: 32768,
  } as Parameters<typeof sanitizeInferenceSettings>[1];

  it("coerces corrupt selections back into range", () => {
    const out = sanitizeInferenceSettings(
      { provider: "nebula", cloudProvider: "x", makalahThinkLevel: "ultra", embedMode: "disk", numCtx: -5 },
      defaults,
    );
    expect(out).toMatchObject({
      provider: "ollama",
      cloudProvider: "openai",
      makalahThinkLevel: "low",
      embedMode: "local",
      numCtx: 32768,
    });
  });

  it("preserves valid stored values", () => {
    const out = sanitizeInferenceSettings({ provider: "cloud", numCtx: 8192 }, defaults);
    expect(out.provider).toBe("cloud");
    expect(out.numCtx).toBe(8192);
  });
});
