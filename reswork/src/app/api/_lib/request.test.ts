import { describe, expect, it, vi, afterEach } from "vitest";
import { getRequestId, logRequest, newRequestId, withRequestId } from "./request";

describe("newRequestId", () => {
  it("mints unique opaque ids", () => {
    const ids = new Set([newRequestId(), newRequestId(), newRequestId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.length).toBeGreaterThan(8);
  });
});

describe("getRequestId", () => {
  it("propagates a well-formed client id (cross-tier correlation)", () => {
    const req = new Request("http://x/", { headers: { "x-request-id": "client-123.ABC" } });
    expect(getRequestId(req)).toBe("client-123.ABC");
  });

  it("mints when absent or malformed (log-injection safe)", () => {
    expect(getRequestId(new Request("http://x/"))).not.toBe("");
    // Fetch validates headers at construction, so bypass it: a raw evil value
    // must still never become the id.
    const evil = { headers: { get: () => "a\nb c" } } as unknown as Request;
    const id = getRequestId(evil);
    expect(id).not.toContain("\n");
  });
});

describe("logRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs duration, status, and id — never raw error text", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
      lines.push(String(line));
    });
    try {
      logRequest("req-1", "test.op", Date.now() - 50, false, { error: new Error("db secret exploded") });
    } finally {
      spy.mockRestore();
    }
    expect(lines.length).toBe(1);
    const payload = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(payload.requestId).toBe("req-1");
    expect(payload.op).toBe("test.op");
    expect(payload.ok).toBe(false);
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.errorCategory).toBe("internal");
    expect(lines[0]).not.toContain("secret");
  });

  it("attaches the id to responses", () => {
    const res = withRequestId(new Response("x"), "req-9");
    expect(res.headers.get("x-request-id")).toBe("req-9");
  });
});
