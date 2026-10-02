import { describe, expect, it } from "vitest";
import {
  buildPrior,
  citedIdsOf,
  escapeHtml,
  isQuotaError,
  mergeReferences,
  parseChapterLine,
  scopeNoteOf,
  summarizeOutput,
} from "./page-support";
import type { MakalahReference, OutlineSubsection, SectionOutput } from "./types";

const out = (texts: string[], cits: string[][] = []): SectionOutput => ({
  paragraphs: texts.map((text, i) => ({
    text,
    citations: (cits[i] ?? []).map((source_id) => ({ source_id, page: null as number | null })),
  })),
} as SectionOutput);

describe("parseChapterLine", () => {
  it("splits BAB number and title, uppercasing the number", () => {
    expect(parseChapterLine("BAB II Pembahasan", 0)).toEqual({ number: "BAB II", title: "Pembahasan" });
    expect(parseChapterLine("bab i pendahuluan", 0)).toEqual({ number: "BAB I", title: "pendahuluan" });
  });

  it("falls back to positional numbering for non-chapter lines", () => {
    expect(parseChapterLine("Daftar Pustaka", 4)).toEqual({ number: "BAB 5", title: "Daftar Pustaka" });
  });
});

describe("escapeHtml", () => {
  it("escapes markup-significant chars", () => {
    expect(escapeHtml("a&b <c> d")).toBe("a&amp;b &lt;c&gt; d");
  });
});

describe("citedIdsOf", () => {
  it("collects unique source ids across outputs, skipping blanks", () => {
    const outputs = [out(["t1"], [["S1", "S2"]]), null, out(["t2"], [["S2", "S3"]])];
    expect(citedIdsOf(outputs).sort()).toEqual(["S1", "S2", "S3"]);
  });
});

describe("mergeReferences", () => {
  it("appends only unseen ids, preserving existing order", () => {
    const prev = [{ id: "a" }, { id: "b" }] as MakalahReference[];
    const fresh = [{ id: "b" }, { id: "c" }] as MakalahReference[];
    expect(mergeReferences(prev, fresh).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("summarizeOutput", () => {
  it("takes the first sentence of each paragraph", () => {
    const s = summarizeOutput(out(["First one. Second one.", "Other para! Tail."]));
    expect(s).toBe("First one.; Other para!");
  });

  it("caps total length", () => {
    const s = summarizeOutput(out(["x".repeat(500), "y".repeat(500)]), 100);
    expect(s.length).toBeLessThanOrEqual(100);
  });
});

describe("buildPrior", () => {
  it("labels items and respects the budget", () => {
    expect(buildPrior([{ label: "1.1", summary: "abc" }])).toBe("- [1.1]: abc");
    const big = buildPrior(
      [
        { label: "1.1", summary: "a".repeat(500) },
        { label: "1.2", summary: "b" },
      ],
      100,
    );
    expect(big).toBe(`- [1.1]: ${"a".repeat(500)}`);
  });
});

describe("scopeNoteOf", () => {
  it("combines focus and exclusions, empty when neither", () => {
    expect(scopeNoteOf({ focus: " causes ", must_not_cover: ["x", "y"] } as OutlineSubsection)).toBe(
      "focus: causes. do NOT cover: x; y",
    );
    expect(scopeNoteOf({} as OutlineSubsection)).toBe("");
  });
});

describe("isQuotaError", () => {
  it("detects quota/rate-limit failures, not model bugs", () => {
    expect(isQuotaError("429 RESOURCE_EXHAUSTED quota exceeded")).toBe(true);
    expect(isQuotaError("rate limit hit, retry later")).toBe(true);
    expect(isQuotaError("model returned invalid JSON")).toBe(false);
    expect(isQuotaError("")).toBe(false);
  });
});
