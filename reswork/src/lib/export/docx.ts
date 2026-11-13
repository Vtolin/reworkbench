import type { PrintDocumentInput } from "@/lib/wb/makalah/document";

export type DocxBlockStyle = "title" | "subtitle" | "h1" | "h2" | "h3" | "bullet" | "body" | "pagebreak";

export interface DocxBlock {
  style: DocxBlockStyle;
  text: string;
}

const INVALID_XML_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
      <w:sz w:val="24"/>
    </w:rPr>
    <w:pPr><w:spacing w:after="140" w:line="312" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="DocTitle">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr>
    <w:pPr><w:spacing w:before="120" w:after="200"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="30"/></w:rPr>
    <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
    <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="24"/></w:rPr>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr>
  </w:style>
</w:styles>`;

function renderBlockXml(block: DocxBlock): string {
  if (block.style === "pagebreak") {
    return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }

  const text = escapeXml(block.text);
  if (block.style === "title") {
    return `<w:p><w:pPr><w:pStyle w:val="DocTitle"/><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }
  if (block.style === "subtitle") {
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="555555"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }
  if (block.style === "h1") {
    return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }
  if (block.style === "h2") {
    return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }
  if (block.style === "h3") {
    return `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }
  if (block.style === "bullet") {
    return `<w:p><w:pPr><w:ind w:left="480" w:hanging="240"/></w:pPr><w:r><w:t xml:space="preserve">• ${text}</w:t></w:r></w:p>`;
  }
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export function buildDocumentXml(blocks: DocxBlock[]): string {
  const bodyXml = blocks.map(renderBlockXml).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

export async function buildDocxBlob(blocks: DocxBlock[]): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", ROOT_RELS_XML);
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/styles.xml", STYLES_XML);
  zip.file("word/document.xml", buildDocumentXml(blocks));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export function markdownToDocxBlocks(title: string, markdown: string, subtitle?: string): DocxBlock[] {
  const blocks: DocxBlock[] = [{ style: "title", text: title }];
  if (subtitle) blocks.push({ style: "subtitle", text: subtitle });

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ style: "body", text: paragraphLines.join(" ").trim() });
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (line.startsWith("### ")) {
      flushParagraph();
      blocks.push({ style: "h3", text: line.slice(4).trim() });
    } else if (line.startsWith("## ")) {
      flushParagraph();
      blocks.push({ style: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("# ")) {
      flushParagraph();
      blocks.push({ style: "h1", text: line.slice(2).trim() });
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      blocks.push({ style: "bullet", text: line.replace(/^[-*]\s+/, "") });
    } else {
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  return blocks;
}

export async function buildResearchDocx(title: string, markdown: string, subtitle?: string): Promise<Blob> {
  return buildDocxBlob(markdownToDocxBlocks(title, markdown, subtitle));
}

export async function buildMakalahDocx(input: PrintDocumentInput): Promise<Blob> {
  const blocks: DocxBlock[] = [{ style: "title", text: input.docTitle }];
  const metaParts = [
    input.cover.author && `${input.isID ? "Penulis" : "Author"}: ${input.cover.author}`,
    input.cover.nim && `NIM/ID: ${input.cover.nim}`,
    input.cover.course && `${input.isID ? "Mata Kuliah" : "Course"}: ${input.cover.course}`,
    input.cover.lecturer && `${input.isID ? "Dosen" : "Lecturer"}: ${input.cover.lecturer}`,
  ].filter(Boolean);
  for (const meta of metaParts) {
    blocks.push({ style: "subtitle", text: meta });
  }
  if (metaParts.length) blocks.push({ style: "pagebreak", text: "" });

  for (const group of input.groups) {
    blocks.push({ style: "h1", text: `${group.ch.chapter_number} ${group.ch.chapter_title}` });
    for (const item of group.items) {
      blocks.push({ style: "h2", text: `${item.sub.number} ${item.sub.title}` });
      const st = input.states[item.key];
      if (st?.output) {
        for (const p of st.output.paragraphs) {
          const cites = p.citations
            .map((c) => `[${input.titleOf(c.source_id)}${c.page ? `, h. ${c.page}` : ""}]`)
            .join(" ");
          blocks.push({ style: "body", text: cites ? `${p.text} ${cites}` : p.text });
        }
      } else {
        blocks.push({ style: "body", text: input.isID ? "Belum dibuat." : "Not yet drafted." });
      }
    }
  }

  blocks.push({ style: "h1", text: input.isID ? "Daftar Pustaka" : "References" });
  for (const r of input.refs) {
    blocks.push({ style: "bullet", text: r.formatted_apa7 });
  }

  return buildDocxBlob(blocks);
}
