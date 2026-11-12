import { describe, expect, it } from "vitest";
import { buildQualityReport, type QualitySectionState } from "./quality";
import { SECTION_SALVAGE_MARKER, type OutlineChapter, type SectionOutput } from "./types";

const chapter = (title: string, numbers: string[]): OutlineChapter => ({
  chapter_number: "BAB I",
  chapter_title: title,
  subsections: numbers.map((number) => ({ number, title: `Sub ${number}` })),
});

const out = (
  texts: string[],
  cites: Array<Array<{ source_id: string; page: number | null }>> = [],
): SectionOutput => ({
  gaps: "",
  paragraphs: texts.map((text, i) => ({ text, citations: cites[i] ?? [] })),
});

const state = (over: Partial<QualitySectionState> = {}): QualitySectionState => ({
  status: "ok",
  output: out(["A claim."]),
  passages: [],
  integrity: null,
  ...over,
});

const base = {
  sections: [{ key: "BAB I::1.1", ch: chapter("Pendahuluan", ["1.1"]), sub: { number: "1.1", title: "Sub 1.1" } }],
  titleOf: (id: string) => `title:${id}`,
  selected: ["S1"],
  outline: [chapter("Pendahuluan", ["1.1"])],
  references: [{ id: "S1", formatted_apa7: "Author. (2024). Title." }],
  citedIds: ["S1"],
  states: {
    "BAB I::1.1": state({
      output: out(["Claim."], [[{ source_id: "S1", page: 3 }]]),
      passages: [{ source_id: "S1", page: 3, paragraph: 0, text: "evidence" }],
    }),
  } satisfies Record<string, QualitySectionState>,
};

describe("buildQualityReport", () => {
  it("reports a complete, fully cited draft", () => {
    const q = buildQualityReport(base);
    expect(q.structure_complete).toBe(true);
    expect(q.citation_total).toBe(1);
    expect(q.citation_integrity_pct).toBe(100);
    expect(q.missing_references).toEqual([]);
    expect(q.unused_sources).toEqual([]);
    expect(q.unsupported_claims).toEqual([]);
  });

  it("marks missing sections and failed generation", () => {
    const q = buildQualityReport({
      ...base,
      sections: [...base.sections, { ...base.sections[0], key: "BAB I::1.2" }],
      states: { ...base.states, "BAB I::1.2": state({ status: "error", error: "boom", output: null }) },
    });
    expect(q.structure_complete).toBe(false);
    expect(q.unsupported_claims).toEqual([
      { subsection: "1.1 Sub 1.1", paragraph: -1, reason: "boom" },
    ]);
  });

  it("flags salvaged raw-text sections", () => {
    const q = buildQualityReport({
      ...base,
      states: {
        "BAB I::1.1": state({ output: out(["raw"]), passages: [] }),
      },
    });
    expect(q.unsupported_claims.some((u) => u.reason.includes("raw-text fallback"))).toBe(false);
    const salvaged = buildQualityReport({
      ...base,
      states: {
        "BAB I::1.1": state({
          output: { gaps: SECTION_SALVAGE_MARKER, paragraphs: [{ text: "raw", citations: [] }] },
        }),
      },
    });
    expect(salvaged.unsupported_claims.some((u) => u.reason.includes("raw-text fallback"))).toBe(true);
  });

  it("separates hallucinated ids from missing bibliography entries", () => {
    const tiny = { source_id: "S9", page: null };
    const q = buildQualityReport({
      ...base,
      states: {
        "BAB I::1.1": state({ output: out(["Claim."], [[tiny]]) }),
      },
      references: [],
      citedIds: ["S9"],
    });
    expect(q.missing_references).toEqual([]);
    expect(q.unsupported_claims.some((u) => u.reason.includes("Cited unknown source id(s): S9"))).toBe(
      true,
    );
  });

  it("flags a dropped page on a page-verifiable source", () => {
    const q = buildQualityReport({
      ...base,
      states: {
        "BAB I::1.1": state({
          output: out(["Claim."], [[{ source_id: "S1", page: null }]]),
          passages: [{ source_id: "S1", page: 3, paragraph: 0, text: "evidence" }],
        }),
      },
    });
    expect(q.citation_missing_pages).toEqual(["1.1 Sub 1.1: title:S1 (1 tanpa halaman)"]);
  });
});
