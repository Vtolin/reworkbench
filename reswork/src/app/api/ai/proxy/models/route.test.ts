import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROUTE_FILE = path.join(__dirname, "route.ts");

function routeSource(): string {
  return fs.readFileSync(ROUTE_FILE, "utf8");
}

describe("models route upstream policy (static guard)", () => {
  it("uses fetchWithTimeout with an explicit 15s deadline, never bare fetch()", () => {
    const src = routeSource();
    expect(src).toContain("fetchWithTimeout");
    expect(src).toContain("15_000");
    // Strip fetchWithTimeout occurrences, then no bare fetch( may remain.
    const withoutHelper = src.replace(/fetchWithTimeout/g, "");
    expect(withoutHelper).not.toMatch(/\bfetch\s*\(/);
  });

  it("enforces auth via resolveApiKey before any upstream call", () => {
    const src = routeSource();
    expect(src).toContain("resolveApiKey");
    const authIdx = src.indexOf("resolveApiKey");
    const fetchIdx = src.indexOf("fetchWithTimeout");
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    // The key check must precede the first upstream fetch.
    expect(authIdx).toBeLessThan(fetchIdx);
    expect(src).toMatch(/if\s*\(!apiKey\)/);
  });
});

// Behavioral auth tests: resolveApiKey is the gate. When it yields no key,
// the route must return its status without touching the network.
vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    resolveApiKey: vi.fn(),
  };
});

import { GET } from "./route";
import { resolveApiKey } from "@/lib/ai/providers";

const mockResolve = resolveApiKey as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  mockResolve.mockReset();
});

describe("GET /api/ai/proxy/models auth gate", () => {
  it("returns 401 without an upstream fetch when the caller is anonymous", async () => {
    mockResolve.mockResolvedValue({ error: "Unauthorized", status: 401 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await GET(new Request("http://localhost/api/ai/proxy/models?provider=openai"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Unauthorized");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockResolve).toHaveBeenCalledWith(undefined, "openai");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 400 without an upstream fetch when no key is stored", async () => {
    mockResolve.mockResolvedValue({ error: "No cloud API key saved", status: 400 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await GET(new Request("http://localhost/api/ai/proxy/models?provider=deepseek"));
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lists models through the bounded fetch when authenticated", async () => {
    mockResolve.mockResolvedValue({ key: "sk-test" });
    const upstream = new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    try {
      const res = await GET(new Request("http://localhost/api/ai/proxy/models?provider=openai"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: string[] };
      expect(body.models).toEqual(["a", "b"]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
