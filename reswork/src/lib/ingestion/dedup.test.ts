import { describe, expect, it } from "vitest";
import {
  checkDuplicates,
  extractDoi,
  normalizeTitle,
  titleFuzzyScore,
  type ExistingDoc,
} from "./dedup";

describe("normalizeTitle", () => {
  it("lowercases, collapses whitespace and strips punctuation", () => {
    expect(normalizeTitle("  Hello,   WORLD! ")).toBe("hello world");
    expect(normalizeTitle(null)).toBe("");
  });
});

describe("extractDoi", () => {
  it("finds a DOI with trailing punctuation stripped, else null", () => {
    expect(extractDoi("see https://doi.org/10.1234/ABC.def, ok")).toBe("10.1234/abc.def");
    expect(extractDoi("no identifier here")).toBeNull();
    expect(extractDoi(null)).toBeNull();
  });
});

describe("titleFuzzyScore", () => {
  it("scores identical titles at 1 and empty input at 0", () => {
    expect(titleFuzzyScore("Same Title", "same title")).toBe(1);
    expect(titleFuzzyScore("", "x")).toBe(0);
  });
});

describe("checkDuplicates", () => {
  it("prioritises hash over DOI over exact title by confidence", () => {
    const proposed = { file_hash: "H1", doi: "10.1/d", title: "Alpha Study" };
    const existing: ExistingDoc[] = [
      { id: "t", title: "alpha study" },
      { id: "d", doi: "10.1/D" },
      { id: "h", file_hash: "h1" },
    ];
    const hits = checkDuplicates(proposed, existing);
    expect(hits.map((h) => h.reason)).toEqual(["hash", "doi", "title_exact"]);
    expect(hits[0].confidence).toBe(1.0);
  });

  it("returns no hits for unrelated documents", () => {
    const hits = checkDuplicates(
      { title: "Completely Different Topic Here", authors: ["Nobody"], year: 1999 },
      [{ id: "x", title: "Quantum Banana Recipes", authors: ["Someone"], year: 2020 }],
    );
    expect(hits).toEqual([]);
  });
});
