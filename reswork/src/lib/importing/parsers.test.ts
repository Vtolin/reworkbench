import { describe, expect, it } from "vitest";
import { parseBibtex, parseReferences } from "./parsers";

describe("parseBibtex", () => {
  it("parses standard brace-delimited BibTeX entries", () => {
    const bib = `
@article{smith2020,
  title = {A Study on Robust Parsing},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  journal = {Journal of Software Engineering},
  volume = {42},
  number = {3},
  pages = {100--115}
}
`;
    const records = parseBibtex(bib);
    expect(records).toHaveLength(1);
    expect(records[0].rawKey).toBe("smith2020");
    expect(records[0].title).toBe("A Study on Robust Parsing");
    expect(records[0].authors).toEqual(["Smith, John", "Doe, Jane"]);
    expect(records[0].year).toBe(2020);
    expect(records[0].journal).toBe("Journal of Software Engineering");
    expect(records[0].volume).toBe("42");
    expect(records[0].issue).toBe("3");
    expect(records[0].pages).toBe("100-115");
  });

  it("parses parenthesis-delimited BibTeX entries: @article(key, ...)", () => {
    const bib = `
@article(paren2021,
  title = {Parenthesis Syntax in BibTeX (With Nested Paren)},
  author = {Brown, Charlie},
  year = {2021},
  journal = {Parser Digest}
)
`;
    const records = parseBibtex(bib);
    expect(records).toHaveLength(1);
    expect(records[0].rawKey).toBe("paren2021");
    expect(records[0].title).toBe("Parenthesis Syntax in BibTeX (With Nested Paren)");
    expect(records[0].authors).toEqual(["Brown, Charlie"]);
    expect(records[0].year).toBe(2021);
  });

  it("recovers and parses subsequent entries when a malformed entry has no closing delimiter", () => {
    const bib = `
@article{broken_entry,
  title = {This entry is broken and missing a closing brace
  author = {Broken, Author}

@article{valid_second,
  title = {Second Valid Entry},
  author = {Valid, Author},
  year = {2022}
}

@article(valid_third,
  title = {Third Valid Entry},
  author = {Another, Author},
  year = {2023}
)
`;
    const records = parseBibtex(bib);
    expect(records).toHaveLength(2);
    expect(records[0].rawKey).toBe("valid_second");
    expect(records[0].title).toBe("Second Valid Entry");
    expect(records[1].rawKey).toBe("valid_third");
    expect(records[1].title).toBe("Third Valid Entry");
  });

  it("auto-detects BibTeX in parseReferences", () => {
    const bib = `
@book{book1,
  title = {Great Book},
  author = {Author, One},
  year = {2019}
}
`;
    const records = parseReferences(bib);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Great Book");
  });
});
