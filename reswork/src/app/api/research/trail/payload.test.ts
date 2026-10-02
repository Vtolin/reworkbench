import { describe, expect, it, vi } from "vitest";

// Phase 3: 32KB payload cap enforced before any membership check or insert.
const dbCalls: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = async () => ({ data: { role: "member" } });
    return {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from: (table: string) => {
        dbCalls.push(`from:${table}`);
        return {
          ...chain,
          insert: (row: unknown) => {
            dbCalls.push(`insert:${table}`);
            void row;
            return { error: null };
          },
        };
      },
    };
  },
  createServiceSupabase: () => ({
    rpc: async () => ({ data: [{ allowed: true, count: 1, retry_after_secs: 0 }], error: null }),
  }),
}));

import { POST } from "./route";

describe("POST /api/research/trail payload cap", () => {
  it("rejects >32KB payloads with 413 before any DB access", async () => {
    dbCalls.length = 0;
    const res = await POST(
      new Request("http://localhost/api/research/trail", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws1",
          event_type: "note",
          payload: { blob: "x".repeat(40_000) },
        }),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("32768");
    expect(dbCalls).toEqual([]);
  });

  it("records small payloads normally", async () => {
    dbCalls.length = 0;
    const res = await POST(
      new Request("http://localhost/api/research/trail", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws1", event_type: "note", payload: { a: 1 } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dbCalls).toContain("insert:research_trail");
  });
});
