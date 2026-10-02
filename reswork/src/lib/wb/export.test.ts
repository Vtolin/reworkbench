import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHAT_MESSAGE_COLUMNS,
  EXPORT_WARN_THRESHOLD_ROWS,
  buildWorkspaceExport,
} from "./export";
import { DOCUMENT_COLUMNS_SELECT } from "./library";

interface Scenario {
  docs: Array<Record<string, unknown>>;
  tables: Record<string, unknown[]>;
  chats: string[];
  messages: Array<Record<string, unknown>>;
}

function fakeClient(s: Scenario, ops: string[]): SupabaseClient {
  return {
    from: (table: string) => {
      const st: { range?: [number, number]; inVals?: unknown[]; limitN?: number; select?: string } = {};
      const chain: Record<string, unknown> = {};
      chain.select = (cols: string) => {
        ops.push(`select:${table}:${cols}`);
        st.select = cols;
        return chain;
      };
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.range = (a: number, b: number) => {
        ops.push(`range:${table}:${a}-${b}`);
        st.range = [a, b];
        return chain;
      };
      chain.limit = (n: number) => {
        st.limitN = n;
        return chain;
      };
      chain.in = (col: string, vals: unknown[]) => {
        ops.push(`in:${table}:${col}:${(vals as unknown[]).length}`);
        st.inVals = vals;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === "documents") {
          const [a, b] = st.range ?? [0, 999];
          resolve({ data: s.docs.slice(a, b + 1) });
        } else if (table === "chats" && st.inVals === undefined) {
          resolve({ data: s.chats.map((id) => ({ id })) });
        } else if (table === "chat_messages") {
          const ids = new Set((st.inVals ?? []) as string[]);
          resolve({ data: s.messages.filter((m) => ids.has(m.chat_id as string)).slice(0, st.limitN ?? 5000) });
        } else {
          resolve({ data: s.tables[table] ?? [] });
        }
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function docs(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ id: `d${i}`, title: `Doc ${i}` }));
}

describe("buildWorkspaceExport (small workspace)", () => {
  it("downloads one file with explicit columns and bounded pages", async () => {
    const ops: string[] = [];
    const out = await buildWorkspaceExport(
      fakeClient(
        {
          docs: docs(1500),
          tables: { collections: [{ id: "c1" }], chats: [{ id: "chat1" }] },
          chats: ["chat1"],
          messages: [
            { id: "m1", chat_id: "chat1", role: "user", content: "hi", metadata_json: {}, created_at: "t" },
          ],
        },
        ops,
      ),
      "ws123456789",
    );
    expect(out.warned).toBe(false);
    expect(out.parts.length).toBe(1);
    expect(out.parts[0].filename).toBe("workbench-export-ws123456.json");
    expect(Object.keys(out.parts[0].data)).toContain("documents");
    expect(Object.keys(out.parts[0].data)).toContain("chat_messages");
    // Explicit columns — never select("*") on the wide tables.
    expect(ops).toContain(`select:documents:${DOCUMENT_COLUMNS_SELECT}`);
    expect(ops).toContain(`select:chat_messages:${CHAT_MESSAGE_COLUMNS}`);
    expect(ops.filter((o) => o.startsWith("select:documents:*"))).toEqual([]);
    expect(ops.filter((o) => o.startsWith("select:chat_messages:*"))).toEqual([]);
    // Cursor-bounded pages, not one 5000-row shot.
    expect(ops.filter((o) => o.startsWith("range:documents:"))).toEqual([
      "range:documents:0-999",
      "range:documents:1000-1999",
    ]);
    expect(out.totalRows).toBe(1500 + 1 + 1 + 1);
  });
});

describe("buildWorkspaceExport (large fixture)", () => {
  it("warns above the threshold and chunks the download", async () => {
    const ops: string[] = [];
    const out = await buildWorkspaceExport(fakeClient({ docs: docs(3500), tables: {}, chats: [], messages: [] }, ops), "ws1");
    expect(out.totalRows).toBe(3500);
    expect(EXPORT_WARN_THRESHOLD_ROWS).toBe(3000);
    expect(out.warned).toBe(true);
    expect(out.warning).toMatch(/3500 rows/);
    expect(out.parts.length).toBe(2);
    expect(out.parts[0].filename).toContain("part1-library");
    expect(out.parts[1].filename).toContain("part2-chats");
    expect(Object.keys(out.parts[0].data)).toContain("documents");
    expect(Object.keys(out.parts[0].data)).not.toContain("chat_messages");
    expect(Object.keys(out.parts[1].data)).toEqual(
      expect.arrayContaining(["chat_messages"]),
    );
    // 3500 rows → 4 bounded pages (3 full + 1 partial).
    expect(ops.filter((o) => o.startsWith("range:documents:"))).toEqual([
      "range:documents:0-999",
      "range:documents:1000-1999",
      "range:documents:2000-2999",
      "range:documents:3000-3999",
    ]);
  });
});

// Writers audit: chat_messages.metadata_json must never carry prompt content.
// Only reproducibility/citation facts are allowlisted.
const METADATA_ALLOWLIST = new Set(["provider", "model", "sources", "thinking", "kind", "topic", "language"]);

function metadataLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const idx = src.indexOf("metadata_json", i);
    if (idx === -1) break;
    // Same-line literal only: every writer in publish.ts is `metadata_json: {`
    // inline. Anything else (destructured params, type refs) is not a value.
    const lineEnd = src.indexOf("\n", idx);
    const colon = src.indexOf(":", idx);
    if (colon === -1 || colon > lineEnd) {
      i = idx + 1;
      continue;
    }
    const open = src.indexOf("{", colon);
    if (open === -1 || open > lineEnd) {
      i = idx + 1;
      continue;
    }
    let depth = 0;
    let inStr: string | null = null;
    let j = open;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open, j + 1));
    i = j + 1;
  }
  return out;
}

describe("chat message metadata (no prompt content)", () => {
  it("restricts writer literals to the allowlist", () => {
    const src = fs.readFileSync(path.join(__dirname, "publish.ts"), "utf8");
    // Value literals only: skip TS type annotations (contain `?`/`string`).
    const literals = metadataLiterals(src).filter(
      (l) => l.includes(":") && !l.includes("?") && !/:\s*(string|number|boolean|unknown)\b/.test(l),
    );
    expect(literals.length).toBeGreaterThan(0);
    for (const lit of literals) {
      // Top-level keys only (depth-1 object entries).
      const keys = [...lit.matchAll(/(?:^|[{,])\s*(\w+)\s*:/g)].map((m) => m[1]);
      for (const key of keys) {
        expect(METADATA_ALLOWLIST.has(key), `metadata_json key "${key}" not allowlisted in: ${lit.slice(0, 80)}`).toBe(true);
      }
    }
    expect(src).not.toMatch(/metadata_json[^}]*\bprompt\b/i);
  });
});
