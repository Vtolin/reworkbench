// Browser-side document loaders: DOCX, XLSX, PPTX, RTF, PDF, and plain text formats.
// Runs 100% client-side (no Python/FastAPI backend, no server filesystem).
// Preserves section headings, table cell boundaries, and pseudo-pagination.

import * as XLSX from "xlsx";
import JSZip from "jszip";
import { PSEUDO_PAGE_CHARS, extractPdfTextBrowser } from "@/lib/ingestion/chunking";

export interface ExtractedDocument {
  text: string;
  pageCount: number | null;
  sections?: Array<{ title: string; text: string; page?: number }>;
}

// ---------------------------------------------------------------------------
// DOCX Loader (via JSZip + OpenXML DOM parsing)
// ---------------------------------------------------------------------------
const HEADING_STYLE_RE = /^(heading|title|subtitle|header)/i;

export async function extractDocxText(file: File | Blob): Promise<ExtractedDocument> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Invalid DOCX file: word/document.xml not found.");
  }
  const xmlStr = await docXmlFile.async("string");

  let doc: Document;
  if (typeof DOMParser !== "undefined") {
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
  } else {
    throw new Error("DOMParser is not available in this environment.");
  }

  const pages: string[] = [];
  let currentPageBuf: string[] = [];
  let currentPageChars = 0;
  let currentSection = "General Section";
  const sections: Array<{ title: string; text: string; page: number }> = [];

  const flushPage = () => {
    if (currentPageBuf.length > 0) {
      pages.push(currentPageBuf.join("\n"));
      currentPageBuf = [];
      currentPageChars = 0;
    }
  };

  const body = doc.getElementsByTagName("w:body")[0];
  if (!body) {
    return { text: "", pageCount: 1, sections: [] };
  }

  const children = Array.from(body.childNodes);
  for (const node of children) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.localName || el.nodeName;

    if (tag === "p") {
      const pStyle = el.querySelector("pStyle")?.getAttribute("w:val") || "";
      const textNodes = el.querySelectorAll("t");
      let pText = "";
      textNodes.forEach((t) => {
        pText += t.textContent || "";
      });
      pText = pText.trim();
      if (!pText) continue;

      if (HEADING_STYLE_RE.test(pStyle)) {
        flushPage();
        currentSection = pText;
        sections.push({ title: currentSection, text: pText, page: pages.length + 1 });
        currentPageBuf.push(`## ${pText}`);
        currentPageChars += pText.length + 3;
        continue;
      }

      currentPageBuf.push(pText);
      currentPageChars += pText.length;
      if (currentPageChars >= PSEUDO_PAGE_CHARS) {
        flushPage();
      }
    } else if (tag === "tbl") {
      const rows = el.querySelectorAll("tr");
      const tableLines: string[] = [];
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll("tc");
        const cellTexts: string[] = [];
        cells.forEach((tc) => {
          const t = tc.textContent?.trim() || "";
          if (t) cellTexts.push(t.replace(/\s+/g, " "));
        });
        if (cellTexts.length > 0) {
          tableLines.push(cellTexts.join(" | "));
        }
      });
      if (tableLines.length > 0) {
        const tblStr = tableLines.join("\n");
        currentPageBuf.push(tblStr);
        currentPageChars += tblStr.length;
        if (currentPageChars >= PSEUDO_PAGE_CHARS) {
          flushPage();
        }
      }
    }
  }
  flushPage();

  const fullText = pages.join("\n\n");
  return {
    text: fullText,
    pageCount: Math.max(pages.length, 1),
    sections,
  };
}

// ---------------------------------------------------------------------------
// XLSX Loader (via SheetJS)
// ---------------------------------------------------------------------------
export async function extractXlsxText(file: File | Blob): Promise<ExtractedDocument> {
  const buf = await file.arrayBuffer();
  const workbook = XLSX.read(buf, { type: "array" });
  const pages: string[] = [];
  const sections: Array<{ title: string; text: string; page: number }> = [];

  for (let sIdx = 0; sIdx < workbook.SheetNames.length; sIdx++) {
    const sheetName = workbook.SheetNames[sIdx];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    const rowLines: string[] = [];

    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cells = row
        .map((c) => (c !== null && c !== undefined ? String(c).trim() : ""))
        .filter((c) => c.length > 0);
      if (cells.length > 0) {
        rowLines.push(cells.join(" | "));
      }
    }

    if (rowLines.length === 0) continue;

    const sectionTitle = `Sheet: ${sheetName}`;
    const pageNum = pages.length + 1;
    sections.push({ title: sectionTitle, text: `[${sectionTitle}]`, page: pageNum });

    let currentBuf: string[] = [`[${sectionTitle}]`];
    let currentChars = currentBuf[0].length;

    for (const line of rowLines) {
      currentBuf.push(line);
      currentChars += line.length;
      if (currentChars >= PSEUDO_PAGE_CHARS) {
        pages.push(currentBuf.join("\n"));
        currentBuf = [];
        currentChars = 0;
      }
    }
    if (currentBuf.length > 0) {
      pages.push(currentBuf.join("\n"));
    }
  }

  const fullText = pages.join("\n\n");
  return {
    text: fullText,
    pageCount: Math.max(pages.length, 1),
    sections,
  };
}

// ---------------------------------------------------------------------------
// PPTX Loader (via JSZip + OpenXML slides)
// ---------------------------------------------------------------------------
export async function extractPptxText(file: File | Blob): Promise<ExtractedDocument> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const slideEntries: Array<{ name: string; num: number; file: JSZip.JSZipObject }> = [];
  zip.forEach((path, entry) => {
    const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
    if (match) {
      slideEntries.push({ name: path, num: parseInt(match[1], 10), file: entry });
    }
  });

  slideEntries.sort((a, b) => a.num - b.num);

  if (slideEntries.length === 0) {
    return { text: "", pageCount: 1, sections: [] };
  }

  const pages: string[] = [];
  const sections: Array<{ title: string; text: string; page: number }> = [];

  for (let i = 0; i < slideEntries.length; i++) {
    const entry = slideEntries[i];
    const xml = await entry.file.async("string");
    const slideNum = entry.num;
    const title = `Slide ${slideNum}`;

    let doc: Document;
    if (typeof DOMParser !== "undefined") {
      doc = new DOMParser().parseFromString(xml, "application/xml");
    } else {
      throw new Error("DOMParser is not available in this environment.");
    }

    const textNodes = doc.querySelectorAll("t");
    const texts: string[] = [];
    textNodes.forEach((t) => {
      const val = t.textContent?.trim() || "";
      if (val) texts.push(val);
    });

    const slideContent = texts.join(" ").replace(/\s+/g, " ");
    const pageText = `[${title}]\n${slideContent}`;
    pages.push(pageText);
    sections.push({ title, text: slideContent, page: i + 1 });
  }

  return {
    text: pages.join("\n\n"),
    pageCount: pages.length,
    sections,
  };
}

// ---------------------------------------------------------------------------
// RTF Loader (deterministic regex control-word stripper)
// ---------------------------------------------------------------------------
const RTF_CONTROL_RE = /\\[a-zA-Z]+-?\d* ?/g;
const RTF_GROUP_RE = /[{}]/g;

export function extractRtfText(rawRtf: string): ExtractedDocument {
  const stripped = rawRtf
    .replace(RTF_CONTROL_RE, " ")
    .replace(RTF_GROUP_RE, "")
    .replace(/\\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  const pages: string[] = [];
  for (let i = 0; i < stripped.length; i += PSEUDO_PAGE_CHARS) {
    pages.push(stripped.slice(i, i + PSEUDO_PAGE_CHARS));
  }

  return {
    text: stripped,
    pageCount: Math.max(pages.length, 1),
  };
}

// ---------------------------------------------------------------------------
// Plain-text family loader (txt, md, csv, tsv, html)
// ---------------------------------------------------------------------------
const HTML_TAG_RE = /<[^>]+>/g;
const MD_HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function extractPlainText(rawText: string, ext: string): ExtractedDocument {
  let text = rawText.replace(/\r\n/g, "\n");
  if (ext === ".html" || ext === ".htm") {
    text = text.replace(HTML_TAG_RE, " ").replace(/[ \t]+/g, " ");
  }

  const pages: string[] = [];
  const sections: Array<{ title: string; text: string; page: number }> = [];

  if (ext === ".md") {
    let currentPageBuf: string[] = [];
    let currentChars = 0;
    for (const line of text.split("\n")) {
      const m = line.trim().match(MD_HEADING_RE);
      if (m) {
        if (currentPageBuf.length > 0) {
          pages.push(currentPageBuf.join("\n"));
          currentPageBuf = [];
          currentChars = 0;
        }
        const heading = m[2].trim();
        sections.push({ title: heading, text: heading, page: pages.length + 1 });
        currentPageBuf.push(line.trim());
        currentChars += line.length;
        continue;
      }
      if (line.trim()) {
        currentPageBuf.push(line);
        currentChars += line.length;
        if (currentChars >= PSEUDO_PAGE_CHARS) {
          pages.push(currentPageBuf.join("\n"));
          currentPageBuf = [];
          currentChars = 0;
        }
      }
    }
    if (currentPageBuf.length > 0) {
      pages.push(currentPageBuf.join("\n"));
    }
  } else {
    for (let i = 0; i < text.length; i += PSEUDO_PAGE_CHARS) {
      pages.push(text.slice(i, i + PSEUDO_PAGE_CHARS));
    }
  }

  return {
    text: pages.length > 0 ? pages.join("\n\n") : text,
    pageCount: Math.max(pages.length, 1),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Master Document Text Extractor Dispatcher
// ---------------------------------------------------------------------------
export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  const filename = file.name.toLowerCase();
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";

  // 1. PDF
  if (ext === ".pdf" || file.type === "application/pdf") {
    return extractPdfTextBrowser(file);
  }

  // 2. Word (DOCX)
  if (
    ext === ".docx" ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxText(file);
  }

  // 3. Excel (XLSX / XLS)
  if (
    ext === ".xlsx" ||
    ext === ".xls" ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel"
  ) {
    return extractXlsxText(file);
  }

  // 4. PowerPoint (PPTX)
  if (
    ext === ".pptx" ||
    file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return extractPptxText(file);
  }

  // 5. RTF
  if (ext === ".rtf" || file.type === "application/rtf") {
    const raw = await file.text();
    return extractRtfText(raw);
  }

  // 6. Plain text, Markdown, CSV, TSV, HTML
  const raw = await file.text();
  return extractPlainText(raw, ext);
}
