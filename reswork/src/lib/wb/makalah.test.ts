import { describe, expect, it } from "vitest";
import {
  cleanPassageForPrompt,
  normalizeAliasCitation,
  parseSectionJson,
  passageKey,
  refineOutline,
  repairJson,
  stripLeakedCitations,
  validateSectionCitations,
  type OutlineChapter,
  type SectionOutput,
  type SectionPassage,
} from "./makalah";

describe("repairJson", () => {
  it("removes trailing commas so LLM output parses", () => {
    const repaired = repairJson('{"a": 1, "b": [2, 3,],}');
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: [2, 3] });
  });
});

describe("citation keys", () => {
  it("builds stable passage keys and normalises alias citations", () => {
    expect(passageKey({ source_id: "d", page: 3, paragraph: null })).toBe("d::3::?");
    expect(normalizeAliasCitation({ source_id: "[s2, h. 5]", page: null })).toEqual({
      source_id: "S2",
      page: 5,
    });
    const passthrough = { source_id: "doc-uuid", page: 2 };
    expect(normalizeAliasCitation({ source_id: passthrough.source_id, page: 2 })).toEqual(passthrough);
  });
});

describe("prompt hygiene", () => {
  it("strips leaked citation shapes but preserves legitimate references", () => {
    const text =
      "Hasil (S1, p. 3) menurut 123e4567-e89b-12d3-a456-426614174000 lihat (UUD 1945).";
    const cleaned = stripLeakedCitations(text);
    expect(cleaned).not.toContain("S1");
    expect(cleaned).not.toContain("123e4567");
    expect(cleaned).toContain("(UUD 1945)");
    expect(cleanPassageForPrompt("[Page 2]\nIsi penting")).toBe("Isi penting");
  });
});

describe("validateSectionCitations", () => {
  it("flags unknown ids and page mismatches while skipping unverifiable sources", () => {
    const passages: SectionPassage[] = [
      { source_id: "a", page: 1, paragraph: 0, text: "t1" },
      { source_id: "a", page: 2, paragraph: 1, text: "t2" },
      { source_id: "b", page: null, paragraph: 0, text: "t3" },
    ];
    const output: SectionOutput = {
      paragraphs: [
        { text: "p1", citations: [{ source_id: "a", page: 1 }, { source_id: "zzz", page: 1 }] },
        { text: "p2", citations: [{ source_id: "a", page: 9 }, { source_id: "b", page: 5 }] },
      ],
      gaps: "",
    };
    const verdict = validateSectionCitations(output, passages);
    expect(verdict.ok).toBe(false);
    expect(verdict.total).toBe(4);
    expect(verdict.valid).toBe(3);
    expect(verdict.badIds).toEqual(["zzz"]);
    expect(verdict.badPages).toEqual(["a@p.9"]);
  });
});

describe("parseSectionJson", () => {
  it("parses fenced model output with type coercion and defaults", () => {
    const parsed = parseSectionJson(
      '```json\n{"paragraphs": [{"text": "t", "citations": [{"source_id": "S1", "page": "3"}]}]}\n```',
    );
    expect(parsed.paragraphs).toHaveLength(1);
    expect(parsed.paragraphs[0].citations).toEqual([{ source_id: "S1", page: 3 }]);
    expect(parsed.gaps).toBe("");
  });
});

describe("refineOutline", () => {
  it("drops duplicates and sourceless subsections, or redirects them to fallback sources", () => {
    const crowded: OutlineChapter[] = [
      {
        chapter_number: "BAB I",
        chapter_title: "Pendahuluan",
        subsections: [
          { number: "1.1", title: "Latar Belakang", source_ids: ["a"] },
          { number: "1.1", title: "Latar Belakang Duplikat", source_ids: ["b"] },
          { number: "1.2", title: "Rumusan Masalah" },
        ],
      },
    ];
    const dropped = refineOutline(crowded, 1, ["a"]);
    expect(dropped.outline[0].subsections).toHaveLength(1);
    expect(dropped.outline[0].subsections[0].number).toBe("1.1");
    expect(dropped.removed).toHaveLength(2);
    expect(dropped.redirected).toEqual([]);

    const thin: OutlineChapter[] = [
      {
        chapter_number: "BAB II",
        chapter_title: "Pembahasan",
        subsections: [{ number: "2.1", title: "Teori Dasar" }],
      },
    ];
    const redirected = refineOutline(thin, 2, ["x"]);
    expect(redirected.outline[0].subsections[0].source_ids).toEqual(["x"]);
    expect(redirected.redirected).toHaveLength(1);
    expect(redirected.removed).toEqual([]);
  });
});
