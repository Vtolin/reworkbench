import { describe, expect, it } from "vitest";
import {
  formatPassagesForPrompt,
  reciprocalRankFusion,
  type FusionInput,
  type RetrievedPassage,
} from "./fusion";

function leg(chunk_id: string, rank: number, legName: FusionInput["leg"]): FusionInput {
  return {
    chunk_id,
    document_id: "d1",
    content: `content-${chunk_id}`,
    chunk_index: 0,
    page: null,
    section: null,
    rank,
    leg: legName,
  };
}

describe("reciprocalRankFusion", () => {
  it("scores a single-leg hit as 1/(60+rank) preserving leg order", () => {
    const out = reciprocalRankFusion([leg("c1", 1, "fts"), leg("c2", 2, "fts")]);
    expect(out.map((p) => p.chunk_id)).toEqual(["c1", "c2"]);
    expect(out[0].score).toBeCloseTo(1 / 61, 6);
    expect(out[0].source).toBe("fusion");
  });

  it("boosts a passage retrieved by multiple legs above single-leg hits", () => {
    const out = reciprocalRankFusion([
      leg("solo", 1, "fts"),
      leg("both", 2, "fts"),
      leg("both", 2, "vector"),
    ]);
    expect(out[0].chunk_id).toBe("both");
    expect(out[0].score).toBeCloseTo(2 / 62, 6);
  });

  it("caps results at topN", () => {
    const legs = [1, 2, 3, 4, 5].map((r) => leg(`c${r}`, r, "fts"));
    const out = reciprocalRankFusion(legs, 60, 2);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.chunk_id)).toEqual(["c1", "c2"]);
  });
});

describe("formatPassagesForPrompt", () => {
  it("renders index, document, location and content", () => {
    const passages: RetrievedPassage[] = [
      {
        chunk_id: "c1",
        document_id: "d1",
        content: "hello",
        chunk_index: 0,
        page: 3,
        section: "Methods",
        score: 0.5,
        source: "fusion",
      },
      {
        chunk_id: "c2",
        document_id: "d1",
        content: "world",
        chunk_index: 1,
        page: null,
        section: null,
        score: 0.4,
        source: "fusion",
      },
    ];
    const text = formatPassagesForPrompt(passages);
    expect(text).toContain("[1] (doc d1, Page 3 · Methods)\nhello");
    expect(text).toContain("[2] (doc d1)\nworld");
  });
});
