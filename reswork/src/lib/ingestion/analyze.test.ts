import { describe, expect, it } from "vitest";
import {
  analyzeText,
  extractTitleCandidate,
  extractYear,
  pageOneText,
} from "./analyze";

describe("extractYear", () => {
  it("accepts explicit imprint patterns only", () => {
    expect(extractYear("© 2021 Example Press")).toBe(2021);
    expect(extractYear("Copyright 2019")).toBe(2019);
    expect(extractYear("Date: 2020-05-01")).toBe(2020);
    expect(extractYear("Published 2020-05-01")).toBe(2020);
  });

  it("never guesses from a bare 4-digit number", () => {
    expect(extractYear("A survey of 2020 studies")).toBeNull();
    expect(extractYear("")).toBeNull();
  });
});

describe("extractTitleCandidate", () => {
  it("prefers a chapter title over the book title", () => {
    const text = "BOOK OF ESSAYS\nCHAPTER 3 Deep Learning for Law\nJane Doe\nAbstract\n…";
    expect(extractTitleCandidate(text, "book.pdf")).toEqual({
      title: "Deep Learning for Law",
      method: "chapter",
    });
  });

  it("strips cover-label prefixes and skips author blobs", () => {
    const text = "Degree Project Deep learning for legal research\nJane Doe\nAbstract\n";
    const out = extractTitleCandidate(text, "unknown.pdf");
    expect(out.title).toBe("Deep learning for legal research");
    expect(out.method).toBe("heading");
  });

  it("falls back to the filename when there is no usable text", () => {
    expect(extractTitleCandidate("", "My_Draft_Paper.pdf")).toEqual({
      title: "My Draft Paper",
      method: "filename",
    });
  });
});

describe("pageOneText", () => {
  it("strips page markers and bounds the slice", () => {
    const out = pageOneText("[Page 1]\nHello\n[Page 2]\nWorld", 100);
    expect(out).not.toContain("[Page");
    expect(out).toContain("Hello");
    expect(out).toContain("World");
    expect(pageOneText("x".repeat(5000), 3000)).toHaveLength(3000);
  });
});

describe("analyzeText", () => {
  it("shares one deterministic metadata pass (title, year, DOI, type, snippet)", () => {
    const text =
      "Deep learning for legal research\nJane Doe\n© 2024\n" +
      "doi: 10.1234/ABC.def.\nAbstract\n" +
      "x".repeat(3000);
    const out = analyzeText("Skripsi Hukum.pdf", text);
    expect(out.title).toBe("Deep learning for legal research");
    expect(out.titleMethod).toBe("heading");
    expect(out.year).toBe(2024);
    expect(out.doi).toBe("10.1234/abc.def");
    expect(out.documentType).toBe("thesis");
    expect(out.textSnippet).toHaveLength(2000);
  });
});
