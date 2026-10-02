import { describe, expect, it } from "vitest";
import { chunkText, chunkTextWithPages, pseudoPaginate } from "./chunking";

describe("chunkText", () => {
  it("returns empty for blank input and a single chunk for short text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
    const single = chunkText("Hello world");
    expect(single).toHaveLength(1);
    expect(single[0].content).toBe("Hello world");
    expect(single[0].chunk_index).toBe(0);
  });

  it("hard-splits spaceless text with the configured overlap", () => {
    const text = "0123456789".repeat(40); // 400 chars, no boundaries
    const chunks = chunkText(text, { chunkSize: 60, chunkOverlap: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunk_index)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0].content).toHaveLength(60);
    // Overlap window [45, 60) must reappear at the start of chunk 2.
    expect(chunks[1].content.startsWith(text.slice(45, 60))).toBe(true);
  });
});

describe("chunkTextWithPages", () => {
  it("assigns real pages with markers stripped, else behaves like chunkText", () => {
    const out = chunkTextWithPages("[Page 1]\nHello world here\n\n[Page 2]\nSecond page text");
    expect(out).toHaveLength(2);
    expect(out[0].page).toBe(1);
    expect(out[1].page).toBe(2);
    expect(out.every((c) => !c.content.includes("[Page"))).toBe(true);
    const plain = chunkTextWithPages("Just some plain text without markers");
    expect(plain).toHaveLength(1);
    expect(plain[0].page ?? null).toBeNull();
  });
});

describe("pseudoPaginate", () => {
  it("slices text into fixed-size pages", () => {
    expect(pseudoPaginate("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });
});
