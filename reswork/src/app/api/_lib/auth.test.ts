import { describe, expect, it } from "vitest";
import { requireAdminRole, requireMemberRole, requireUserId } from "./auth";

function errorOf(result: { error: Response }): Response {
  return result.error;
}

async function errorBody(result: { error: Response }): Promise<{ status: number; body: string }> {
  const payload: unknown = await result.error.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("error" in payload) ||
    typeof payload.error !== "string"
  ) {
    throw new Error("unexpected error response shape");
  }
  return { status: result.error.status, body: payload.error };
}

describe("requireUserId", () => {
  it("returns the caller id for an authenticated session", () => {
    expect(requireUserId("u1")).toEqual({ userId: "u1" });
  });

  it("rejects anonymous callers with 401 and no internals", async () => {
    const result = requireUserId(null);
    if (!("error" in result)) throw new Error("expected an error result");
    expect(await errorBody(result)).toEqual({ status: 401, body: "Unauthorized" });
  });
});

describe("requireAdminRole", () => {
  it("allows admins", () => {
    expect(requireAdminRole("admin")).toEqual({ ok: true });
  });

  it("rejects non-admin members with 403 and no internals", async () => {
    const result = requireAdminRole("member");
    if (!("error" in result)) throw new Error("expected an error result");
    expect(await errorBody(result)).toEqual({ status: 403, body: "Admin only" });
  });

  it("rejects missing roles (non-members, removed, invalid workspace)", async () => {
    const result = requireAdminRole(null);
    if (!("error" in result)) throw new Error("expected an error result");
    expect((await errorBody(result)).status).toBe(403);
  });
});

describe("requireMemberRole", () => {
  it("allows admins and members", () => {
    expect(requireMemberRole("admin")).toEqual({ ok: true });
    expect(requireMemberRole("member")).toEqual({ ok: true });
  });

  it("rejects outsiders with 403 and no internals", async () => {
    const result = requireMemberRole(null);
    if (!("error" in result)) throw new Error("expected an error result");
    const { status, body } = await errorBody(result);
    expect(status).toBe(403);
    expect(body).toBe("Workspace access required");
    expect(body).not.toMatch(/postgres|sql|relation|uuid/i);
  });

  it("fails closed on unrecognized role strings", () => {
    // Cross-workspace confusion or future roles must never read as access.
    const result = requireMemberRole("owner");
    expect("error" in result).toBe(true);
    expect("error" in requireAdminRole("superadmin")).toBe(true);
  });
});

describe("guard composition", () => {
  it("keeps error responses free of stack traces and database text", async () => {
    for (const result of [requireUserId(null), requireAdminRole(null), requireMemberRole(null)]) {
      if (!("error" in result)) throw new Error("expected an error result");
      const { body } = await errorBody(result);
      expect(body).not.toMatch(/Error|stack|at |postgres|SELECT|relation/i);
      expect(errorOf(result)).toBeInstanceOf(Response);
    }
  });
});
