import { describe, expect, it } from "vitest";
import {
  linkFilterCalls,
  linkFilterMatched,
  linkJoinSelects,
  resolveDocLinkIds,
  resolveLimit,
  type LinkIdFetcher,
} from "./docFilters";

describe("linkJoinSelects", () => {
  it("emits one semi-join per filtered dimension, none otherwise", () => {
    expect(linkJoinSelects({})).toEqual([]);
    expect(linkJoinSelects({ collectionIds: ["c1"] })).toEqual(["document_collections!inner(collection_id)"]);
    expect(linkJoinSelects({ tagIds: ["t1"], authorIds: ["a1"] })).toEqual([
      "document_tags!inner(tag_id)",
      "document_authors!inner(author_id)",
    ]);
  });
});

describe("linkFilterCalls", () => {
  it("emits exactly the requested IN predicates (single shared shape)", () => {
    expect(linkFilterCalls({})).toEqual([]);
    expect(linkFilterCalls({ collectionIds: ["c1"], tagIds: ["t1", "t2"] })).toEqual([
      { column: "document_collections.collection_id", values: ["c1"] },
      { column: "document_tags.tag_id", values: ["t1", "t2"] },
    ]);
  });
});

describe("resolveDocLinkIds", () => {
  it("builds workspace-bound patterns with LIKE escaping (tag exact, rest contains)", async () => {
    const seen: Array<[string, string]> = [];
    const fetch: LinkIdFetcher = async (table, pattern) => {
      seen.push([table, pattern]);
      return table === "authors" ? ["a1"] : table === "tags" ? ["t1"] : [];
    };
    const out = await resolveDocLinkIds(fetch, { author: "Smi%th", tag: "Bio", collection: "Phys_ics" });
    expect(out).toEqual({ authorIds: ["a1"], tagIds: ["t1"], collectionIds: [] });
    expect(seen).toEqual([
      ["authors", "%Smi\\%th%"],
      ["tags", "Bio"],
      ["collections", "%Phys\\_ics%"],
    ]);
    expect(resolveLimit()).toBe(20);
  });

  it("leaves unrequested dimensions undefined", async () => {
    const out = await resolveDocLinkIds(async () => ["x"], { author: "Nobody" });
    expect(out.authorIds).toEqual(["x"]);
    expect(out.tagIds).toBeUndefined();
    expect(out.collectionIds).toBeUndefined();
  });
});

describe("linkFilterMatched", () => {
  it("fails closed on requested-but-unmatched filters (empty page 1)", () => {
    expect(linkFilterMatched({}, {})).toBe(true);
    expect(linkFilterMatched({ author: "A" }, { authorIds: ["a1"] })).toBe(true);
    expect(linkFilterMatched({ tag: "T" }, { tagIds: [] })).toBe(false);
    expect(linkFilterMatched({ author: "A", tag: "T" }, { authorIds: ["a1"], tagIds: [] })).toBe(false);
  });
});
