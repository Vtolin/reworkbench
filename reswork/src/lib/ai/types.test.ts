import { describe, expect, it } from "vitest";
import { toProviderMessages } from "./types";
import { toSectionPassage } from "../wb/makalah/types";
import { toSearchPassages } from "../wb/search";

// Boundary mappers (Phase 6): stored/retrieved shapes cross into their
// canonical owners through exactly one function each.
describe("toProviderMessages", () => {
  it("picks exactly the wire fields (no UI internals leak)", () => {
    expect(
      toProviderMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "system", content: "be nice" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "be nice" },
    ]);
    const out = toProviderMessages([{ role: "user", content: "x", id: "drop", timestamp: 1 } as unknown as {
      role: "user";
      content: string;
    }]);
    expect(out).toEqual([{ role: "user", content: "x" }]);
    expect(Object.keys(out[0]).sort()).toEqual(["content", "role"]);
  });
});

describe("toSectionPassage", () => {
  it("maps retrieval fields into makalah evidence slots", () => {
    expect(
      toSectionPassage({ document_id: "d1", page: 3, chunk_index: 7, content: "text", score: 0.9 }),
    ).toEqual({ source_id: "d1", page: 3, paragraph: 7, text: "text", score: 0.9 });
    expect(
      toSectionPassage({ document_id: "d1", page: null, chunk_index: null, content: "t", score: 0 }),
    ).toMatchObject({ paragraph: null, page: null });
  });
});

describe("toSearchPassages", () => {
  it("resolves titles with id fallback", () => {
    const titles = new Map([["d1", "Paper One"]]);
    expect(
      toSearchPassages(
        [
          { content: "a", document_id: "d1", page: 1, section: "s" },
          { content: "b", document_id: "dx", page: null, section: null },
        ],
        titles,
      ),
    ).toEqual([
      { text: "a", source: "Paper One", page: 1, section: "s", document_id: "d1" },
      { text: "b", source: "dx", page: null, section: null, document_id: "dx" },
    ]);
  });
});
