import { describe, expect, it, vi } from "vitest";
import { chunkTextWithPages } from "./chunking";
import { formatOcrPagesText, MAX_OCR_PAGES, ocrSinglePageImage } from "./ocr";

describe("scanned PDF OCR helpers", () => {
  it("formats OCR pages with [Page N] markers compatible with chunkTextWithPages", () => {
    const combined = formatOcrPagesText([
      { page: 1, text: "First page scanned paragraph." },
      { page: 2, text: "   " },
      { page: 3, text: "Third page findings." },
    ]);

    expect(combined).toBe("[Page 1]\nFirst page scanned paragraph.\n\n[Page 3]\nThird page findings.");

    const chunks = chunkTextWithPages(combined);
    expect(chunks.map((c) => c.page)).toEqual([1, 3]);
    expect(chunks[0].content).toBe("First page scanned paragraph.");
    expect(chunks[1].content).toBe("Third page findings.");
    expect(MAX_OCR_PAGES).toBe(10);
  });

  it("sends base64 page images to local Ollama /api/chat when mode is local", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: { content: "Recovered Ollama text" } }), { status: 200 })
    ) as unknown as typeof fetch;

    const text = await ocrSinglePageImage(
      "FAKEBASE64",
      2,
      { mode: "local", model: "qwen2.5vl:7b" },
      fetchMock
    );

    expect(text).toBe("Recovered Ollama text");
    const calls = (fetchMock as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls[0][0]).toBe("http://localhost:11434/api/chat");
    const payload = JSON.parse(String(calls[0][1].body)) as {
      model: string;
      messages: Array<{ images?: string[] }>;
    };
    expect(payload.model).toBe("qwen2.5vl:7b");
    expect(payload.messages[0].images).toEqual(["FAKEBASE64"]);
  });

  it("sends multimodal image_url payload to /api/ai/proxy when mode is cloud", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: "Recovered Cloud text" }), { status: 200 })
    ) as unknown as typeof fetch;

    const text = await ocrSinglePageImage(
      "FAKEBASE64",
      1,
      { mode: "cloud", model: "gpt-4o-mini", cloudProvider: "openai" },
      fetchMock
    );

    expect(text).toBe("Recovered Cloud text");
    const calls = (fetchMock as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls[0][0]).toBe("/api/ai/proxy");
    const payload = JSON.parse(String(calls[0][1].body)) as {
      provider: string;
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    expect(payload.provider).toBe("openai");
    expect(payload.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,FAKEBASE64" },
    });
  });
});
