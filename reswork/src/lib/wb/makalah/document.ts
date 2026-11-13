// Makalah document builders (Markdown + print/PDF HTML).
//
// Pure functions over already-drafted state: no React, no I/O, no browser
// APIs. The page passes in the same flat/chapter-grouped items it renders,
// so preview, copy, publish and print can never disagree about ordering,
// citation formatting, or bibliography contents.
import { escapeHtml } from "./page-support";
import type {
  MakalahReference,
  OutlineChapter,
  OutlineSubsection,
  SectionOutput,
} from "./types";

export interface DocumentItem {
  key: string;
  ch: OutlineChapter;
  sub: OutlineSubsection;
}

export interface DocumentGroup {
  ch: OutlineChapter;
  items: DocumentItem[];
}

/** Minimal per-section state needed to render a document. */
export interface DocumentSectionState {
  output: SectionOutput | null;
}

export interface CoverInfo {
  title: string;
  author: string;
  nim: string;
  course: string;
  lecturer: string;
}

export interface MarkdownDocumentInput {
  docTitle: string;
  isID: boolean;
  groups: DocumentGroup[];
  states: Record<string, DocumentSectionState | undefined>;
  refs: MakalahReference[];
  titleOf: (id: string) => string;
}

export interface PrintDocumentInput extends MarkdownDocumentInput {
  language: string;
  cover: CoverInfo;
  outline: OutlineChapter[];
}

/** Markdown export body (Copy Markdown / shared publish). */
export function buildMarkdownDocument({
  docTitle,
  isID,
  groups,
  states,
  refs,
  titleOf,
}: MarkdownDocumentInput): string {
  const lines: string[] = [`# ${docTitle}`, ""];
  for (const g of groups) {
    lines.push(`## ${g.ch.chapter_number} ${g.ch.chapter_title}`, "");
    for (const item of g.items) {
      const st = states[item.key];
      lines.push(`### ${item.sub.number} ${item.sub.title}`, "");
      if (st?.output) {
        for (const p of st.output.paragraphs) {
          const cites = p.citations
            .map((c) => `[${titleOf(c.source_id)}${c.page ? `, h. ${c.page}` : ""}]`)
            .join(" ");
          lines.push(`${p.text}${cites ? ` ${cites}` : ""}`, "");
        }
        // gaps intentionally excluded: drafting-view QA, never published
      } else {
        lines.push("_Belum dibuat._", "");
      }
    }
  }
  lines.push(`## ${isID ? "Daftar Pustaka" : "References"}`, "");
  refs.forEach((r) => lines.push(`- ${r.formatted_apa7}`));
  return lines.join("\n");
}

/** Full print-view HTML (Export PDF opens this in a new window). */
export function buildPrintHtml({
  docTitle,
  isID,
  language,
  cover,
  outline,
  groups,
  states,
  refs,
  titleOf,
}: PrintDocumentInput): string {
  const secHtml = groups
    .map(
      ({ ch, items }) => `
      <h2>${escapeHtml(ch.chapter_number)} ${escapeHtml(ch.chapter_title)}</h2>
      ${items
        .map((item) => {
          const st = states[item.key];
          const paras =
            st?.output?.paragraphs
              .map((p) => {
                const cites = p.citations
                  .map(
                    (c) =>
                      `<span class="cite">[${escapeHtml(titleOf(c.source_id))}${
                        c.page ? `, h. ${c.page}` : ""
                      }]</span>`,
                  )
                  .join(" ");
                return `<p>${escapeHtml(p.text)} ${cites}</p>`;
              })
              .join("") ?? "<p><em>Belum dibuat.</em></p>";
          // gaps intentionally excluded: drafting-view QA, never published
          return `<h3>${escapeHtml(item.sub.number)} ${escapeHtml(item.sub.title)}</h3>${paras}`;
        })
        .join("")}`,
    )
    .join("");
  const toc = outline
    .map(
      (ch) => `
      <div class="toc-ch">${escapeHtml(ch.chapter_number)} ${escapeHtml(ch.chapter_title)}</div>
      ${ch.subsections
        .map((s) => `<div class="toc-sub">${escapeHtml(s.number)} ${escapeHtml(s.title)}</div>`)
        .join("")}`,
    )
    .join("");

  return `<!DOCTYPE html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8">
      <title>${escapeHtml(docTitle)}</title>
      <style>
        body{font-family:Georgia,serif;max-width:68ch;margin:2rem auto;line-height:1.7;padding:0 1rem;color:#111}
        .cover{text-align:center;margin:6rem 0 4rem;page-break-after:always}
        .cover h1{font-size:1.6rem;margin-bottom:2rem;text-transform:uppercase}
        .cover p{margin:.3rem 0}
        h2{font-size:1.2rem;margin-top:2.2rem;text-transform:uppercase;border-bottom:1px solid #999;padding-bottom:.3rem}
        h3{font-size:1.05rem;margin-top:1.4rem}
        .cite{color:#444;font-size:.85em}
        .gap{background:#f5f5f5;border-left:3px solid #999;padding:.4rem .8rem;font-size:.9em}
        .toc-ch{font-weight:bold;margin-top:.6rem}
        .toc-sub{margin-left:1.2rem}
        ol.refs li{margin-bottom:.5rem}
        @media print{.cover{margin-top:0}}
      </style></head><body>
      <div class="cover"><h1>${escapeHtml(docTitle)}</h1>
        ${cover.author ? `<p>${escapeHtml(cover.author)}${cover.nim ? ` - ${escapeHtml(cover.nim)}` : ""}</p>` : ""}
        ${cover.course ? `<p>${escapeHtml(cover.course)}</p>` : ""}
        ${cover.lecturer ? `<p>${escapeHtml(cover.lecturer)}</p>` : ""}
      </div>
      <h2>${isID ? "Daftar Isi" : "Table of Contents"}</h2>${toc}
      ${secHtml}
      <h2>${isID ? "Daftar Pustaka" : "References"}</h2>
      <ol class="refs">${refs.map((r) => `<li>${escapeHtml(r.formatted_apa7)}</li>`).join("")}</ol>
      </body></html>`;
}
