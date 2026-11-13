import { afterEach, describe, expect, it, vi } from "vitest";
import { executeProviderWebSearch, WebSearchProviderError } from "./providers";

describe("executeProviderWebSearch", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("queries Ollama Web Search API with Bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [{ title: "UU Cipta Kerja", url: "https://peraturan.bpk.go.id/1", content: "Pasal 1 memuat..." }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await executeProviderWebSearch("ollama_web", "oll_key_123", "uu cipta kerja", 5);
    expect(res).toHaveLength(1);
    expect(res[0]?.url).toBe("https://peraturan.bpk.go.id/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/web_search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer oll_key_123" }),
      }),
    );
  });

  it("supports Google Custom Search JSON API when key uses cx:key format", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [{ title: "ArXiv Paper", link: "https://arxiv.org/abs/2501.00001", snippet: "Abstract text here." }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await executeProviderWebSearch("google_web", "cx123:AIzaTestKey", "rag citations", 4);
    expect(res[0]).toEqual({
      title: "ArXiv Paper",
      url: "https://arxiv.org/abs/2501.00001",
      content: "Abstract text here.",
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("customsearch/v1");
  });

  it("supports Google Gemini Search Grounding for standard AIza keys", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Summary output." }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://nature.com/articles/s1", title: "Nature Study" } }],
                groundingSupports: [{ segment: { text: "Verified empirical result from Nature." }, groundingChunkIndices: [0] }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await executeProviderWebSearch("google_web", "AIzaStandardKey", "climate study", 5);
    expect(res[0]).toEqual({
      title: "Nature Study",
      url: "https://nature.com/articles/s1",
      content: "Verified empirical result from Nature.",
    });
  });

  it("queries Tavily and Brave APIs and surfaces provider HTTP errors", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("tavily")) {
        return new Response(
          JSON.stringify({ results: [{ title: "Tavily", url: "https://mit.edu/doc", content: "MIT note." }] }),
          { status: 200 },
        );
      }
      if (target.includes("brave.com")) {
        return new Response(
          JSON.stringify({ web: { results: [{ title: "Brave", url: "https://who.int/report", description: "WHO data." }] } }),
          { status: 200 },
        );
      }
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;

    const t = await executeProviderWebSearch("tavily", "tvly-1", "ai", 3);
    expect(t[0]?.url).toBe("https://mit.edu/doc");

    const b = await executeProviderWebSearch("brave", "bsa-1", "health", 3);
    expect(b[0]?.url).toBe("https://who.int/report");

    globalThis.fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(executeProviderWebSearch("ollama_web", "bad", "test", 3)).rejects.toBeInstanceOf(
      WebSearchProviderError,
    );
  });
});
