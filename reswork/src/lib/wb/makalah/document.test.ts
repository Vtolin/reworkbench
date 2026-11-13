import { describe, expect, it } from "vitest";
import { buildMarkdownDocument, buildPrintHtml } from "./document";
import type { OutlineChapter, SectionOutput } from "./types";

const outline: OutlineChapter[] = [
  {
    chapter_number: "BAB I",
    chapter_title: "Pendahuluan",
    subsections: [
      { number: "1.1", title: "Latar Belakang" },
      { number: "1.2", title: "Rumusan" },
    ],
  },
];
const groups = [{ ch: outline[0], items: outline[0].subsections.map((sub, i) => ({ ch: outline[0], sub, key: `k${i}` })) }];
const output: SectionOutput = {
  gaps: "",
  paragraphs: [{ text: "Klaim utama.", citations: [{ source_id: "S1", page: 7 }] }],
};
const refs = [{ id: "S1", formatted_apa7: "Author. (2024). Judul." }];
const titleOf = (id: string) => (id === "S1" ? "Author (2024)" : id);

describe("buildMarkdownDocument", () => {
  it("renders chapters, sections, citations, placeholders and references", () => {
    const md = buildMarkdownDocument({
      docTitle: "Makalah Uji",
      isID: true,
      groups,
      states: { k0: { output }, k1: { output: null } },
      refs,
      titleOf,
    });
    expect(md).toContain("# Makalah Uji");
    expect(md).toContain("## BAB I Pendahuluan");
    expect(md).toContain("### 1.1 Latar Belakang");
    expect(md).toContain("Klaim utama. [Author (2024), h. 7]");
    expect(md).toContain("### 1.2 Rumusan\n\n_Belum dibuat._");
    expect(md).toContain("## Daftar Pustaka");
    expect(md).toContain("- Author. (2024). Judul.");
  });

  it("uses the English references heading outside Indonesian drafts", () => {
    const md = buildMarkdownDocument({
      docTitle: "Paper",
      isID: false,
      groups,
      states: { k0: { output }, k1: { output } },
      refs,
      titleOf,
    });
    expect(md).toContain("## References");
  });
});

describe("buildPrintHtml", () => {
  it("escapes content, includes the cover, TOC and bibliography", () => {
    const html = buildPrintHtml({
      docTitle: "A <B>",
      isID: true,
      language: "id-ID",
      cover: { title: "", author: "Ani", nim: "123", course: "Hukum", lecturer: "Dr. X" },
      outline,
      groups,
      states: { k0: { output: { ...output, paragraphs: [{ text: "<script>x</script>", citations: [] }] } }, k1: { output: null } },
      refs,
      titleOf,
    });
    expect(html).toContain("<title>A &lt;B&gt;</title>");
    expect(html).toContain("Ani - 123");
    expect(html).toContain("Daftar Isi");
    expect(html).toContain("1.1 Latar Belakang");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("Daftar Pustaka");
    expect(html).toContain("Author. (2024). Judul.");
  });
});
