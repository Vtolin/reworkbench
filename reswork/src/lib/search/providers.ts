import { fetchWithTimeout, HttpStatusError } from "@/lib/async/net";
import type { RawWebResult, WebSearchProviderId } from "./webFilter";

const SEARCH_TIMEOUT_MS = 20_000;

export class WebSearchProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

function clampMaxResults(n?: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 8;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

async function readJsonOrThrow(res: Response, provider: WebSearchProviderId): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    try {
      const txt = await res.text();
      detail = txt.slice(0, 180);
    } catch {
      detail = res.statusText;
    }
    throw new WebSearchProviderError(
      res.status >= 400 && res.status < 600 ? res.status : 502,
      `${provider} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.json();
}

async function searchOllamaWeb(apiKey: string, query: string, maxResults: number): Promise<RawWebResult[]> {
  const res = await fetchWithTimeout(
    "https://ollama.com/api/web_search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    },
    SEARCH_TIMEOUT_MS,
  );
  const data = (await readJsonOrThrow(res, "ollama_web")) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
  };
  return (data.results ?? []).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    content: typeof r.content === "string" ? r.content : "",
  }));
}

async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<RawWebResult[]> {
  const res = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: false,
      }),
    },
    SEARCH_TIMEOUT_MS,
  );
  const data = (await readJsonOrThrow(res, "tavily")) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
  };
  return (data.results ?? []).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    content: typeof r.content === "string" ? r.content : "",
  }));
}

async function searchBrave(apiKey: string, query: string, maxResults: number): Promise<RawWebResult[]> {
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    },
    SEARCH_TIMEOUT_MS,
  );
  const data = (await readJsonOrThrow(res, "brave")) as {
    web?: {
      results?: Array<{
        title?: unknown;
        url?: unknown;
        description?: unknown;
        extra_snippets?: unknown;
      }>;
    };
  };
  return (data.web?.results ?? []).map((r) => {
    const desc = typeof r.description === "string" ? r.description : "";
    const extras = Array.isArray(r.extra_snippets)
      ? r.extra_snippets.filter((x): x is string => typeof x === "string").join(" ")
      : "";
    return {
      title: typeof r.title === "string" ? r.title : "",
      url: typeof r.url === "string" ? r.url : "",
      content: `${desc} ${extras}`.trim(),
    };
  });
}

async function searchGoogleCustom(
  cx: string,
  key: string,
  query: string,
  maxResults: number,
): Promise<RawWebResult[]> {
  const endpoint = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${maxResults}`;
  const res = await fetchWithTimeout(endpoint, { method: "GET" }, SEARCH_TIMEOUT_MS);
  const data = (await readJsonOrThrow(res, "google_web")) as {
    items?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>;
  };
  return (data.items ?? []).map((item) => ({
    title: typeof item.title === "string" ? item.title : "",
    url: typeof item.link === "string" ? item.link : "",
    content: typeof item.snippet === "string" ? item.snippet : "",
  }));
}

async function searchGoogleGeminiGrounding(
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<RawWebResult[]> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `Search the web and summarize key factual sources for: ${query}` }],
          },
        ],
        tools: [{ google_search: {} }],
      }),
    },
    SEARCH_TIMEOUT_MS,
  );
  const data = (await readJsonOrThrow(res, "google_web")) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        groundingSupports?: Array<{
          segment?: { text?: string };
          groundingChunkIndices?: number[];
        }>;
      };
    }>;
  };
  const cand = data.candidates?.[0];
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const supports = cand?.groundingMetadata?.groundingSupports ?? [];
  const summaryText = (cand?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();

  const snippetsByIdx = new Map<number, string[]>();
  for (const sup of supports) {
    const seg = sup.segment?.text?.trim();
    if (!seg || !Array.isArray(sup.groundingChunkIndices)) continue;
    for (const idx of sup.groundingChunkIndices) {
      const list = snippetsByIdx.get(idx) ?? [];
      list.push(seg);
      snippetsByIdx.set(idx, list);
    }
  }

  return chunks
    .slice(0, maxResults)
    .map((c, idx) => {
      const uri = c.web?.uri ?? "";
      const title = c.web?.title ?? "";
      const joined = (snippetsByIdx.get(idx) ?? []).join(" ").trim();
      return {
        title: title || uri,
        url: uri,
        content: joined || summaryText,
      };
    })
    .filter((r) => Boolean(r.url));
}

async function searchGoogleWeb(apiKey: string, query: string, maxResults: number): Promise<RawWebResult[]> {
  const sep = apiKey.indexOf(":");
  if (sep > 0 && sep < apiKey.length - 1) {
    const cx = apiKey.slice(0, sep).trim();
    const key = apiKey.slice(sep + 1).trim();
    if (cx && key) {
      return searchGoogleCustom(cx, key, query, maxResults);
    }
  }
  return searchGoogleGeminiGrounding(apiKey.trim(), query, maxResults);
}

export async function executeProviderWebSearch(
  provider: WebSearchProviderId,
  apiKey: string,
  query: string,
  maxResults?: number,
): Promise<RawWebResult[]> {
  const limit = clampMaxResults(maxResults);
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  try {
    switch (provider) {
      case "ollama_web":
        return await searchOllamaWeb(apiKey, trimmedQuery, limit);
      case "google_web":
        return await searchGoogleWeb(apiKey, trimmedQuery, limit);
      case "tavily":
        return await searchTavily(apiKey, trimmedQuery, limit);
      case "brave":
        return await searchBrave(apiKey, trimmedQuery, limit);
    }
  } catch (err) {
    if (err instanceof HttpStatusError) {
      throw new WebSearchProviderError(err.status, err.message);
    }
    throw err;
  }
}
