"use client";
import React from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

// Lightweight markdown + LaTeX renderer for chat messages.
// Covers code fences, inline code, bold, italic, links, headings, lists,
// blockquotes, horizontal rules, GFM tables, and LaTeX (inline $...$ / \(...\) and block $$...$$ / \[...\] via KaTeX).

function renderLatexToHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode,
      strict: false,
      trust: true,
    });
  } catch {
    return `<span class="text-red-400">${latex}</span>`;
  }
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // First, handle LaTeX - split by display and inline delimiters
  // Process display math $$...$$ and \[...\] first, then inline $...$ and \(...\)
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let lastIndex = 0;
  let keyCounter = 0;

  // Combined regex for LaTeX: $$...$$, \[...\], \(...\), $...$
  // Note: $$ must be checked before $
  const latexRegex = /(\$\$[\s\S]+?\$\$)|(\\\[[\s\S]+?\\\])|(\\\([\s\S]+?\\\))|(\$[^\$\n]+?\$)/g;
  
  const processTextWithMarkdown = (plainText: string, prefix: string): React.ReactNode[] => {
    if (!plainText) return [];
    const mdNodes: React.ReactNode[] = [];
    const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = regex.exec(plainText)) !== null) {
      if (m.index > last) mdNodes.push(plainText.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("`")) {
        mdNodes.push(<code key={`${prefix}-c${idx++}`} className="bg-[#2f2f2f] border border-[#3f3f3f] px-1.5 py-0.5 rounded text-[0.85em] font-mono text-[#e5e5e5]">{tok.slice(1, -1)}</code>);
      } else if (tok.startsWith("**")) {
        mdNodes.push(<strong key={`${prefix}-b${idx++}`} className="font-semibold text-white">{processTextWithMarkdown(tok.slice(2, -2), `${prefix}-b${idx}`)}</strong>);
      } else if (tok.startsWith("[")) {
        const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (mm && /^https?:\/\//i.test(mm[2])) {
          mdNodes.push(<a key={`${prefix}-l${idx++}`} href={mm[2]} target="_blank" rel="noopener noreferrer" className="text-[#ab68ff] underline decoration-[#ab68ff]/40 hover:decoration-[#ab68ff]">{mm[1]}</a>);
        } else {
          mdNodes.push(tok);
        }
      } else {
        mdNodes.push(<em key={`${prefix}-i${idx++}`} className="italic">{tok.slice(1, -1)}</em>);
      }
      last = m.index + tok.length;
    }
    if (last < plainText.length) mdNodes.push(plainText.slice(last));
    return mdNodes;
  };

  let match: RegExpExecArray | null;
  const textNodes: React.ReactNode[] = [];
  
  // Reset regex
  latexRegex.lastIndex = 0;
  
  while ((match = latexRegex.exec(text)) !== null) {
    // Text before LaTeX
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      textNodes.push(...processTextWithMarkdown(before, `${keyPrefix}-t${keyCounter++}`));
    }
    
    const fullMatch = match[0];
    let latexContent = "";
    let displayMode = false;
    
    if (fullMatch.startsWith("$$")) {
      latexContent = fullMatch.slice(2, -2);
      displayMode = true;
    } else if (fullMatch.startsWith("\\[")) {
      latexContent = fullMatch.slice(2, -2);
      displayMode = true;
    } else if (fullMatch.startsWith("\\(")) {
      latexContent = fullMatch.slice(2, -2);
      displayMode = false;
    } else if (fullMatch.startsWith("$")) {
      latexContent = fullMatch.slice(1, -1);
      displayMode = false;
    }
    
    const html = renderLatexToHtml(latexContent, displayMode);
    if (displayMode) {
      textNodes.push(<span key={`${keyPrefix}-k${keyCounter++}`} className="block my-2 text-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />);
    } else {
      textNodes.push(<span key={`${keyPrefix}-k${keyCounter++}`} dangerouslySetInnerHTML={{ __html: html }} />);
    }
    
    lastIndex = match.index + fullMatch.length;
  }
  
  // Remaining text after last LaTeX
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    textNodes.push(...processTextWithMarkdown(remaining, `${keyPrefix}-t${keyCounter++}`));
  }
  
  return textNodes.length ? textNodes : processTextWithMarkdown(text, keyPrefix);
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  // Must contain at least --- and only contain |, :, -, spaces
  if (!/---/.test(trimmed)) return false;
  return /^[\s|:\-]+$/.test(trimmed);
}

function parseTableRow(line: string): string[] {
  // Handle both | a | b | and a | b formats
  let trimmed = line.trim();
  // Remove leading/trailing |
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(cell => cell.trim());
}

function getAlignment(cell: string): 'left' | 'center' | 'right' {
  const t = cell.trim();
  if (/^:---.*---:$/.test(t) || /^:.*:$/.test(t)) return 'center';
  if (/^:---/.test(t)) return 'left';
  if (/---:$/.test(t)) return 'right';
  return 'left';
}

export default function Markdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let codeLang = "";
  let listType: "ul" | "ol" | null = null;
  let listItems: React.ReactNode[] = [];

  const flushList = () => {
    if (listType && listItems.length) {
      blocks.push(
        listType === "ul"
          ? <ul key={key++} className="my-1.5 pl-5 space-y-1 list-disc marker:text-[#5f5f5f]">{listItems}</ul>
          : <ol key={key++} className="my-1.5 pl-5 space-y-1 list-decimal marker:text-[#5f5f5f]">{listItems}</ol>
      );
    }
    listType = null;
    listItems = [];
  };
  const flushCode = () => {
    if (codeBuf.length) {
      blocks.push(
        <pre key={key++} className="my-2 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] p-3 overflow-x-auto text-[13px] leading-relaxed font-mono text-[#e5e5e5] whitespace-pre-wrap break-words">
          <code>{codeBuf.join("\n")}</code>
        </pre>
      );
      codeBuf = [];
      codeLang = "";
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      flushList();
      if (inCode) { flushCode(); inCode = false; }
      else { 
        inCode = true; 
        codeLang = line.trimStart().slice(3).trim();
      }
      i++;
      continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // Check for LaTeX block ($$ on its own line)
    const trimmedForLatex = line.trim();
    if (trimmedForLatex === "$$" || trimmedForLatex.startsWith("$$") && trimmedForLatex.endsWith("$$") && trimmedForLatex.length > 4) {
      flushList();
      if (trimmedForLatex === "$$") {
        // Multi-line display math
        const latexLines: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "$$") {
          latexLines.push(lines[i]);
          i++;
        }
        i++; // skip closing $$
        const latex = latexLines.join("\n");
        const html = renderLatexToHtml(latex, true);
        blocks.push(<div key={key++} className="my-3 text-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />);
        continue;
      } else {
        // Single line $$...$$
        const latex = trimmedForLatex.slice(2, -2);
        const html = renderLatexToHtml(latex, true);
        blocks.push(<div key={key++} className="my-3 text-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />);
        i++;
        continue;
      }
    }
    
    // Check for \[...\] block
    if (trimmedForLatex.startsWith("\\[") && trimmedForLatex.endsWith("\\]")) {
      flushList();
      const latex = trimmedForLatex.slice(2, -2);
      const html = renderLatexToHtml(latex, true);
      blocks.push(<div key={key++} className="my-3 text-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />);
      i++;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) { flushList(); blocks.push(<div key={key++} className="h-2" />); i++; continue; }

    // Check for table - must have | and next line is separator
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList();
      const headerCells = parseTableRow(line);
      const alignCells = parseTableRow(lines[i + 1]).map(getAlignment);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const rowLine = lines[j].trim();
        if (!rowLine || !rowLine.includes('|')) break;
        // Stop if it's not a table row (e.g., heading, code fence)
        if (/^(#{1,4}\s|```|-{3,}|\*{3,}|_{3,}|>|[-*+]\s|\d+[.)]\s)/.test(rowLine)) break;
        rows.push(parseTableRow(lines[j]));
        j++;
      }
      
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto rounded-xl border border-[#2f2f2f]">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#1a1a1a] border-b border-[#2f2f2f]">
                {headerCells.map((cell, idx) => (
                  <th key={idx} className="px-3 py-2.5 text-left font-semibold text-white whitespace-nowrap border-r border-[#2f2f2f] last:border-r-0" style={{ textAlign: alignCells[idx] || 'left' }}>
                    {renderInline(cell, `th${key}-${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className={rowIdx % 2 === 0 ? "bg-[#0a0a0a]" : "bg-[#171717]"} >
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-[#ececec] border-r border-[#2f2f2f] last:border-r-0 border-t border-[#1a1a1a]" style={{ textAlign: alignCells[cellIdx] || 'left' }}>
                      {renderInline(cell, `td${key}-${rowIdx}-${cellIdx}`)}
                    </td>
                  ))}
                  {/* Fill missing cells if row has fewer columns than header */}
                  {Array.from({ length: Math.max(0, headerCells.length - row.length) }).map((_, idx) => (
                    <td key={`empty-${idx}`} className="px-3 py-2 border-r border-[#2f2f2f] last:border-r-0 border-t border-[#1a1a1a]" />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = j;
      continue;
    }

    const h = trimmed.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flushList();
      const level = h[1].length;
      const cls = level === 1
        ? "text-lg font-semibold text-white mt-3 mb-1"
        : level === 2
          ? "text-base font-semibold text-white mt-2.5 mb-1"
          : level === 3
            ? "text-sm font-semibold text-white mt-2 mb-1"
            : "text-sm font-medium text-white mt-2 mb-1";
      blocks.push(<div key={key++} className={cls}>{renderInline(h[2], `h${key}`)}</div>);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList();
      blocks.push(<hr key={key++} className="my-3 border-[#2f2f2f]" />);
      i++;
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)/);
    if (quote) {
      flushList();
      blocks.push(
        <blockquote key={key++} className="my-1.5 border-l-2 border-[#3f3f3f] pl-3 text-[#b4b4b4] italic">{renderInline(quote[1], `q${key}`)}</blockquote>
      );
      i++;
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.*)/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (ulMatch || olMatch) {
      const nextType: "ul" | "ol" = ulMatch ? "ul" : "ol";
      if (listType !== nextType) { flushList(); listType = nextType; }
      listItems.push(<li key={key++} className="leading-relaxed">{renderInline((ulMatch || olMatch)![1], `li${key}`)}</li>);
      i++;
      continue;
    }

    flushList();
    const para: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|-{3,}|\*{3,}|_{3,}|>|[-*+]\s|\d+[.)]\s)/.test(lines[i].trimStart()) &&
      !(lines[i].trim().includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1.5 leading-relaxed">
        {para.map((p, pi) => (
          <React.Fragment key={pi}>
            {pi > 0 && <br />}
            {renderInline(p, `p${key}-${pi}`)}
          </React.Fragment>
        ))}
      </p>
    );
  }
  flushList();
  flushCode();

  return <div className="text-[#ececec] leading-relaxed">{blocks}</div>;
}
