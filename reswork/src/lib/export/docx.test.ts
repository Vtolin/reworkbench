import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildMakalahDocx, buildResearchDocx, escapeXml, markdownToDocxBlocks } from "./docx";

describe("OpenXML docx builder", () => {
  it("escapes XML special characters and strips invalid control characters", () => {
    expect(escapeXml(`Law & <Policy> "v1"\u0007`)).toBe("Law &amp; &lt;Policy&gt; &quot;v1&quot;");
  });

  it("parses markdown headings and bullets into DocxBlocks", () => {
    const blocks = markdownToDocxBlocks("Summary", "# Section\n## Sub\n- Point one\nParagraph body.");
    expect(blocks.map((b) => b.style)).toEqual(["title", "h1", "h2", "bullet", "body"]);
  });

  it("produces a valid zipped .docx package for research markdown", async () => {
    const blob = await buildResearchDocx(
      "AI Governance Synthesis",
      "## Key Findings\nModels require audit logs & human oversight.",
      "Cross-Paper Synthesis"
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    expect(zip.file("_rels/.rels")).toBeTruthy();
    expect(zip.file("word/styles.xml")).toBeTruthy();
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toContain("AI Governance Synthesis");
    expect(xml).toContain("audit logs &amp; human oversight.");
  });

  it("produces a valid zipped .docx package for Makalah structured papers", async () => {
    const blob = await buildMakalahDocx({
      docTitle: "Legal AI Review",
      isID: false,
      language: "en",
      cover: { title: "Legal AI Review", author: "A. Researcher", nim: "101", course: "Seminar", lecturer: "Prof. X" },
      outline: [],
      groups: [
        {
          ch: { chapter_number: "Chapter I", chapter_title: "Introduction" } as never,
          items: [
            {
              key: "1.1",
              ch: { chapter_number: "Chapter I", chapter_title: "Introduction" } as never,
              sub: { number: "1.1", title: "Background" } as never,
            },
          ],
        },
      ],
      states: {
        "1.1": {
          output: {
            paragraphs: [{ text: "Statutory citations require verification.", citations: [{ source_id: "s1", page: 12 }] }],
          } as never,
        },
      },
      refs: [{ id: "r1", formatted_apa7: "Smith, J. (2024). Legal AI." } as never],
      titleOf: () => "Smith 2024",
    });

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")?.async("string");
    expect(xml).toContain("Legal AI Review");
    expect(xml).toContain("[Smith 2024, h. 12]");
    expect(xml).toContain("Smith, J. (2024). Legal AI.");
  });
});
