import { describe, expect, it, vi } from "vitest";
import {
  buildBookmarkletHref,
  cleanZoteroDoi,
  fetchZoteroItems,
  validateZoteroTarget,
  zoteroItemToImportRecord,
} from "./zotero";

describe("zotero import helpers", () => {
  it("validates numeric library IDs and rejects path traversal", () => {
    expect(() =>
      validateZoteroTarget({ libraryType: "users", libraryId: "../admin" })
    ).toThrow(/numeric/);
    expect(() =>
      validateZoteroTarget({ libraryType: "groups", libraryId: "12345", collectionKey: "../bad" })
    ).toThrow(/collection key/i);

    const valid = validateZoteroTarget({
      libraryType: "users",
      libraryId: " 987654 ",
      apiKey: " zk_test ",
      collectionKey: "AB12CD34",
      limit: 500,
    });
    expect(valid).toEqual({
      libraryType: "users",
      libraryId: "987654",
      apiKey: "zk_test",
      collectionKey: "AB12CD34",
      limit: 200,
    });
  });

  it("maps Zotero items to ImportRecord and skips attachments/notes", () => {
    expect(
      zoteroItemToImportRecord({ key: "N1", data: { itemType: "note", title: "Note" } })
    ).toBeNull();
    expect(
      zoteroItemToImportRecord({ key: "A1", data: { itemType: "attachment", title: "PDF" } })
    ).toBeNull();

    const cols = new Map([["COL1", "AI Governance"]]);
    const rec = zoteroItemToImportRecord(
      {
        key: "ITEM1",
        data: {
          itemType: "journalArticle",
          title: "Algorithmic Accountability",
          creators: [
            { firstName: "Ada", lastName: "Lovelace" },
            { name: "ACM Panel" },
          ],
          date: "2024-06-15",
          DOI: "https://doi.org/10.1145/12345.6789",
          publicationTitle: "Nature Machine Intelligence",
          volume: "6",
          issue: "2",
          pages: "10-22",
          publisher: "Springer",
          abstractNote: "Paper abstract",
          collections: ["COL1"],
        },
      },
      cols
    );

    expect(rec).toEqual({
      title: "Algorithmic Accountability",
      authors: ["Ada Lovelace", "ACM Panel"],
      year: 2024,
      doi: "10.1145/12345.6789",
      journal: "Nature Machine Intelligence",
      volume: "6",
      issue: "2",
      pages: "10-22",
      publisher: "Springer",
      abstract: "Paper abstract",
      rawKey: "ITEM1",
      collections: ["AI Governance"],
    });
    expect(cleanZoteroDoi("doi: 10.1000/xyz")).toBe("10.1000/xyz");
  });

  it("fetches Zotero API v3 items with expected headers and collection mapping", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/collections?")) {
        return new Response(JSON.stringify([{ key: "COL9", data: { name: "Legal NLP" } }]), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify([
          {
            key: "Z1",
            data: {
              itemType: "conferencePaper",
              title: "Statute Retrieval",
              creators: [{ firstName: "Grace", lastName: "Hopper" }],
              date: "2023",
              collections: ["COL9"],
            },
          },
        ]),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const records = await fetchZoteroItems(
      { libraryType: "groups", libraryId: "4242", apiKey: "secret-key" },
      fetchMock
    );

    expect(records).toHaveLength(1);
    expect(records[0].collections).toEqual(["Legal NLP"]);
    const calls = (fetchMock as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    expect(calls[1][0]).toContain("https://api.zotero.org/groups/4242/items/top");
    expect((calls[1][1].headers as Record<string, string>)["Zotero-API-Version"]).toBe("3");
    expect((calls[1][1].headers as Record<string, string>)["Zotero-API-Key"]).toBe("secret-key");
  });

  it("builds a javascript clipper bookmarklet URL targeting /upload", () => {
    const href = buildBookmarkletHref("https://workbench.example.org/");
    expect(href.startsWith("javascript:")).toBe(true);
    expect(href).toContain("https://workbench.example.org");
    expect(href).toContain("/upload?doi=");
  });
});
