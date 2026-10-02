import { describe, expect, it, vi, beforeEach } from "vitest";

// Phase 3: per-user rate budget + 256KB messages cap on the billed POST.
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  }),
  createServiceSupabase: () => ({
    rpc: async () => ({ data: [{ allowed: true, count: 1, retry_after_secs: 0 }], error: null }),
  }),
}));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/ai/proxy", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ai/proxy safety gates", () => {
  it("rejects oversized conversations with 413 before any upstream call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await POST(
        req({ provider: "openai", model: "gpt-4o-mini", messages: [{ role: "user", content: "x".repeat(300_000) }] }),
      );
      expect(res.status).toBe(413);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
