import { describe, expect, it, vi, beforeEach } from "vitest";

// Partial-failure coverage for the bootstrap (Phase 3): every step that can
// fail must trigger compensating deletes in reverse order, each logged.
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  rateLimited: false,
  createError: false,
  workspaceError: false,
  memberError: false,
  profileError: false,
}));

function chainableEq(table: string, op: string) {
  const self: { eq: (...args: unknown[]) => typeof self; error: null } = {
    error: null,
    eq: (...args: unknown[]) => {
      mocks.calls.push(`${op}:${table}:${String(args[0])}`);
      return self;
    },
  };
  return self;
}

vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({
    rpc: async () => {
      mocks.calls.push("rpc:check_rate_limit");
      return mocks.rateLimited
        ? { data: [{ allowed: false, count: 6, retry_after_secs: 30 }], error: null }
        : { data: [{ allowed: true, count: 1, retry_after_secs: 0 }], error: null };
    },
    auth: {
      admin: {
        createUser: async () => {
          mocks.calls.push("createUser");
          return mocks.createError
            ? { data: { user: null }, error: { message: "email taken" } }
            : { data: { user: { id: "u1" } }, error: null };
        },
        deleteUser: async () => {
          mocks.calls.push("deleteUser");
          return { data: {}, error: null };
        },
      },
    },
    from: (table: string) => ({
      insert: (row: unknown) => {
        mocks.calls.push(`insert:${table}`);
        if (table === "workspaces") {
          return {
            select: () => ({
              single: async () =>
                mocks.workspaceError
                  ? { data: null, error: { message: "ws boom" } }
                  : { data: { id: "ws1" }, error: null },
            }),
          };
        }
        void row;
        return { error: mocks.memberError && table === "workspace_members" ? { message: "member boom" } : null };
      },
      upsert: () => {
        mocks.calls.push(`upsert:${table}`);
        return { error: mocks.profileError ? { message: "profile boom" } : null };
      },
      delete: () => {
        mocks.calls.push(`delete:${table}`);
        return chainableEq(table, "delete");
      },
    }),
  }),
  createServerSupabase: () => {
    throw new Error("not used by register-admin");
  },
}));

import { POST } from "./route";

const KEY = "test-admin-key";

function req(body: unknown, ip = "9.9.9.9"): Request {
  return new Request("http://localhost/api/auth/register-admin", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.calls = [];
  mocks.rateLimited = false;
  mocks.createError = false;
  mocks.workspaceError = false;
  mocks.memberError = false;
  mocks.profileError = false;
  process.env.ADMIN_REGISTRATION_KEY = KEY;
});

describe("POST /api/auth/register-admin", () => {
  it("returns 429 before touching auth when the IP is over budget", async () => {
    mocks.rateLimited = true;
    const res = await POST(req({ email: "a@x.co", password: "pw", admin_key: KEY }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(mocks.calls).toEqual(["rpc:check_rate_limit"]);
  });

  it("compensates the auth user when workspace creation fails", async () => {
    mocks.workspaceError = true;
    const res = await POST(req({ email: "a@x.co", password: "pw", admin_key: KEY }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Registration failed" });
    expect(mocks.calls).toEqual(["rpc:check_rate_limit", "createUser", "insert:workspaces", "deleteUser"]);
  });

  it("compensates workspace then user when membership fails", async () => {
    mocks.memberError = true;
    const res = await POST(req({ email: "a@x.co", password: "pw", admin_key: KEY }));
    expect(res.status).toBe(500);
    expect(mocks.calls).toEqual([
      "rpc:check_rate_limit",
      "createUser",
      "insert:workspaces",
      "insert:workspace_members",
      "delete:workspaces",
      "delete:workspaces:id",
      "deleteUser",
    ]);
  });

  it("compensates member, workspace, user (reverse order) when profile fails", async () => {
    mocks.profileError = true;
    const res = await POST(req({ email: "a@x.co", password: "pw", admin_key: KEY }));
    expect(res.status).toBe(500);
    expect(mocks.calls).toEqual([
      "rpc:check_rate_limit",
      "createUser",
      "insert:workspaces",
      "insert:workspace_members",
      "upsert:profiles",
      "delete:workspace_members",
      "delete:workspace_members:workspace_id",
      "delete:workspace_members:user_id",
      "delete:workspaces",
      "delete:workspaces:id",
      "deleteUser",
    ]);
  });

  it("succeeds with no compensation on the happy path (retry-safe shape)", async () => {
    const res = await POST(req({ email: "a@x.co", password: "pw", admin_key: KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workspaceId: "ws1", userId: "u1" });
    expect(mocks.calls).not.toContain("deleteUser");
  });
});
