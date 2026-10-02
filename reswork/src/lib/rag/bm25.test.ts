import { describe, expect, it } from "vitest";
import { bm25Rank, tokenize } from "./bm25";

describe("tokenize", () => {
  it("lowercases and strips stopwords", () => {
    expect(tokenize("The Quick, brown FOX!")).toEqual(["quick", "brown", "fox"]);
  });

  it("returns empty for blank or stopword-only fragments", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("a I")).toEqual([]);
  });
});

describe("bm25Rank", () => {
  it("ranks the topically relevant document first, deterministically", () => {
    const docs = [
      { id: "a", content: "quantum computing breakthroughs in quantum hardware" },
      { id: "b", content: "recipes for banana bread with walnuts" },
    ];
    const first = bm25Rank("quantum computing", docs);
    const second = bm25Rank("quantum computing", docs);
    expect(first[0].id).toBe("a");
    expect(first[0].score).toBeGreaterThan(first[1].score);
    expect(second).toEqual(first);
  });

  it("returns no items for an empty collection", () => {
    expect(bm25Rank("anything", [])).toEqual([]);
  });

  it("prefers a section-header match when content is otherwise identical", () => {
    const docs = [
      { id: "plain", content: "quantum computing research advances" },
      { id: "headed", content: "quantum computing research advances", section: "Quantum Computing" },
    ];
    const ranked = bm25Rank("quantum computing", docs);
    expect(ranked[0].id).toBe("headed");
  });
});
