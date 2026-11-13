import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const selectInMock = vi.fn();
const upsertMock = vi.fn();
const deleteEqMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: selectInMock,
        })),
      })),
      upsert: upsertMock,
      delete: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: deleteEqMock,
        })),
      })),
    })),
  })),
}));

const resolveApiKeyMock = vi.fn();
vi.mock("@/lib/ai/providers", () => ({
  resolveApiKey: (...args: unknown[]) => resolveApiKeyMock(...args),
}));

vi.mock("@/lib/ai/keys", () => ({
  encryptApiKey: vi.fn((k: string) => ({ ciphertext: `enc:${k}`, iv: "iv123" })),
}));

vi.mock("@/app/api/_lib/rateLimit", () => ({
  enforceRateLimit: vi.fn(async () => null),
}));

const executeSearchMock = vi.fn();
vi.mock("@/lib/search/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search/providers")>();
  return {
    ...actual,
    executeProviderWebSearch: (...args: unknown[]) => executeSearchMock(...args),
  };
});

import { DELETE, GET, POST, PUT } from "./route";

describe("/api/search/web route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    selectInMock.mockResolvedValue({ data: [{ provider: "ollama_web" }], error: null });
    upsertMock.mockResolvedValue({ error: null });
    deleteEqMock.mockResolvedValue({ error: null });
    resolveApiKeyMock.mockResolvedValue({ key: "oll_secret" });
  });

  it("GET returns configured provider names for signed-in user", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ configuredProviders: ["ollama_web"] });
  });

  it("PUT validates provider & saves encrypted key", async () => {
    const res = await PUT(
      new Request("http://localhost/api/search/web", {
        method: "PUT",
        body: JSON.stringify({ provider: "ollama_web", apiKey: "oll_123" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      { user_id: "u1", provider: "ollama_web", ciphertext: "enc:oll_123", iv: "iv123" },
      { onConflict: "user_id,provider" },
    );
  });

  it("DELETE removes stored provider key", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/search/web", {
        method: "DELETE",
        body: JSON.stringify({ provider: "tavily" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("POST rejects when no key is saved and filters slop when results return", async () => {
    resolveApiKeyMock.mockResolvedValueOnce({ status: 400, error: "missing" });
    const missingRes = await POST(
      new Request("http://localhost/api/search/web", {
        method: "POST",
        body: JSON.stringify({ query: "uu cipta kerja", provider: "ollama_web" }),
      }),
    );
    expect(missingRes.status).toBe(400);

    executeSearchMock.mockResolvedValueOnce([
      {
        title: "Quora Spam",
        url: "https://www.quora.com/q",
        content: "Quora generic text that should be filtered out from results.",
      },
      {
        title: "BPK Peraturan",
        url: "https://peraturan.bpk.go.id/Details/1",
        content: "Undang-Undang Nomor 11 Tahun 2020 tentang Cipta Kerja dan peraturan pelaksanaannya.",
      },
    ]);

    const okRes = await POST(
      new Request("http://localhost/api/search/web", {
        method: "POST",
        body: JSON.stringify({ query: "uu cipta kerja", provider: "ollama_web", filterMode: "balanced" }),
      }),
    );
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { results: Array<{ domain: string }>; filteredOutCount: number };
    expect(body.filteredOutCount).toBe(1);
    expect(body.results.map((r) => r.domain)).toEqual(["peraturan.bpk.go.id"]);
  });
});
