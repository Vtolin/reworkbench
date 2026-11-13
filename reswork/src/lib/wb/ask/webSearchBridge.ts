import type { FilteredWebResult } from "@/lib/search/webFilter";
import type { InferenceSelection, Source } from "./types";

export interface WebContextBundle {
  sources: Source[];
  promptBlock: string;
  count: number;
  filteredOutCount: number;
}

/**
 * Fetches anti-slop filtered live web search results via the authenticated
 * `/api/search/web` proxy and formats them into Source citations + prompt text.
 */
export async function fetchFilteredWebSources(
  query: string,
  sel: InferenceSelection,
  signal?: AbortSignal,
): Promise<WebContextBundle> {
  if (!sel.webSearch) {
    return { sources: [], promptBlock: "", count: 0, filteredOutCount: 0 };
  }
  const res = await fetch("/api/search/web", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      query,
      provider: sel.webSearchProvider ?? "ollama_web",
      filterMode: sel.webSearchFilterMode ?? "balanced",
      maxResults: sel.broad ? 8 : 5,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Web search failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as {
    results?: FilteredWebResult[];
    filteredOutCount?: number;
  };
  const items = data.results ?? [];
  const sources: Source[] = items.map((r, i) => ({
    citation: `[Web W${i + 1} · ${r.domain}] ${r.title} (${r.url})`,
    snippet: r.content,
    document_id: `web:${i + 1}`,
    page: null,
    section: r.trustTier,
  }));
  const promptBlock = items
    .map(
      (r, i) =>
        `[W${i + 1}] (${r.trustTier.toUpperCase()} - ${r.domain}: ${r.title} | ${r.url})\n${r.content}`,
    )
    .join("\n\n");
  return {
    sources,
    promptBlock,
    count: items.length,
    filteredOutCount: data.filteredOutCount ?? 0,
  };
}
