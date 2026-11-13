import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceSelection } from "./types";
import { fetchFilteredWebSources } from "./webSearchBridge";

const baseSel: InferenceSelection = {
  provider: "ollama",
  model: "gemma4:26b-a4b-it-qat",
  cloudProvider: "openai",
  cloudModel: "gpt-4o-mini",
  temperature: 0,
  numCtx: 32768,
  embedMode: "local",
  webSearch: true,
  webSearchProvider: "ollama_web",
  webSearchFilterMode: "balanced",
};

describe("fetchFilteredWebSources", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("returns empty bundle when webSearch toggle is off", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchFilteredWebSources("test", { ...baseSel, webSearch: false });
    expect(res.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats filtered web results into Source citations and prompt context", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          filteredOutCount: 2,
          results: [
            {
              title: "Putusan MK",
              url: "https://mahkamahkonstitusi.go.id/putusan/1",
              domain: "mahkamahkonstitusi.go.id",
              content: "Pertimbangan hukum Mahkamah Konstitusi.",
              trustTier: "government",
              trustScore: 20,
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const bundle = await fetchFilteredWebSources("putusan mk", baseSel);
    expect(bundle.count).toBe(1);
    expect(bundle.filteredOutCount).toBe(2);
    expect(bundle.sources[0]?.citation).toBe(
      "[Web W1 · mahkamahkonstitusi.go.id] Putusan MK (https://mahkamahkonstitusi.go.id/putusan/1)",
    );
    expect(bundle.promptBlock).toContain("[W1] (GOVERNMENT - mahkamahkonstitusi.go.id:");
  });
});
