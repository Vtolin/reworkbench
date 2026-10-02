import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Member-limit race (Phase 3): the limit is enforced by the atomic
// join_workspace() RPC (migration 0011: advisory lock + recount + insert in
// one transaction). These tests pin the wiring: the route delegates to that
// single RPC (no standalone insert = no check-then-act window) and maps every
// outcome to the pre-existing UX messages. True multi-connection atomicity is
// a live-DB property — the migration carries a static guard below, and a
// staging concurrency probe is tracked as a follow-up.
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  existing: null as { status: string } | null,
  count: 0,
  joinQueue: [] as Array<string | { message: string }>,
}));

function makeChain(table: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    mocks.calls.push(`select:${table}:${String(args[0])}`);
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    mocks.calls.push(`eq:${table}:${String(args[0])}`);
    return chain;
  };
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => {
    mocks.calls.push(`maybeSingle:${table}`);
    if (table === "workspace_members") return { data: mocks.existing };
    return { data: null };
  };
  chain.single = async () => {
    mocks.calls.push(`single:${table}`);
    if (table === "workspaces") return { data: { id: "ws1", member_limit: 10 }, error: null };
    return { data: null, error: null };
  };
  chain.upsert = async () => {
    mocks.calls.push(`upsert:${table}`);
    return { error: null };
  };
  // Count fast-path: `await builder` resolves the head count.
  chain.then = (resolve: (v: unknown) => void) => resolve({ count: mocks.count, error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  }),
  createServiceSupabase: () => ({
    from: (table: string) => makeChain(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      const next = mocks.joinQueue.shift() ?? "ok";
      if (typeof next === "object") return { data: null, error: next };
      return { data: next, error: null };
    },
  }),
}));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/workspaces/members", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.calls = [];
  mocks.existing = null;
  mocks.count = 0;
  mocks.joinQueue = [];
});

describe("POST /api/workspaces/members", () => {
  it("joins through the atomic RPC with the clamped limit", async () => {
    const res = await POST(req({ userId: "u1", workspaceId: "ws1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rpcCall = mocks.calls.find((c) => c.startsWith("rpc:join_workspace:"));
    expect(rpcCall).toContain('"p_workspace_id":"ws1"');
    expect(rpcCall).toContain('"p_user_id":"u1"');
    expect(rpcCall).toContain('"p_limit":10');
  });

  it("maps a lost race (full) to the closed message, not a silent over-join", async () => {
    // Fast-path count says 9/10, but the RPC (recount under lock) says full.
    mocks.count = 9;
    mocks.joinQueue = ["full"];
    const res = await POST(req({ userId: "u1", workspaceId: "ws1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Registration is currently closed. Please contact the administrator.",
    });
  });

  it("serializes overlapping joins (double submit): first ok, second full", async () => {
    mocks.count = 9;
    mocks.joinQueue = ["ok", "full"];
    const [first, second] = await Promise.all([
      POST(req({ userId: "u1", workspaceId: "ws1" })),
      POST(req({ userId: "u1", workspaceId: "ws1" })),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(mocks.calls.filter((c) => c.startsWith("rpc:join_workspace:")).length).toBe(2);
  });

  it("maps revoked and RPC errors without leaking internals", async () => {
    mocks.joinQueue = ["revoked"];
    const revoked = await POST(req({ userId: "u1", workspaceId: "ws1" }));
    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as { error: string }).error).toMatch(/revoked/i);

    mocks.joinQueue = [{ message: "connection reset" }];
    const failed = await POST(req({ userId: "u1", workspaceId: "ws1" }));
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: string }).error).not.toMatch(/reset/i);
  });
});

describe("join race closure (static guards)", () => {
  it("performs no standalone membership insert (single-RPC write path)", () => {
    const src = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
    expect(src).toContain('rpc("join_workspace"');
    expect(src).not.toMatch(/from\("workspace_members"\)\.insert\(/);
  });

  it("backs the RPC with lock + recount + insert in one transaction", () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "supabase",
        "migrations",
        "0011_workspace_join_limit.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("pg_advisory_xact_lock(hashtext(");
    expect(sql).toMatch(/count\(\*\)[\s\S]*into current_count/);
    expect(sql).toContain("insert into public.workspace_members");
    expect(sql).toContain("grant execute");
    expect(sql).toContain("service_role");
  });
});
