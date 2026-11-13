// Deterministic text analysis for ingestion: title/year/DOI/document-type
// proposal from extracted text. Pure string handling - no DOM, no I/O, no AI.
//
// Extracted from lib/wb/ingest.ts so the same rules run identically on the
// main thread and inside the ingest Web Worker (and stay unit-testable).
import { classifyDocumentType } from "@/lib/ingestion/classify";
import { extractDoi } from "@/lib/ingestion/dedup";

/** Lines that look like venue/cover labels rather than the document's own title.
 *  Generic shape patterns only - no topic or field keywords. */
const TITLE_JUNK_RE =
  /^(working papers?( \d| no\.| are)?|degree project|course code|findings of|draft (of|version)|copyright|all rights reserved|authors?(\s*[:–-])?|supervisor|examiner|subject|level|department of|school of|faculty of|chapter \d+|figure \d+|table \d+|contents|daftar isi|abstrak$|abstract$|keywords?\s*[:–-]|kata kunci\s*[:–-])/i;
const VENUE_HINT_RE = /(proceedings|findings of|journal of|working paper|chapter \d+|degree project|technical report|conference on|transactions on)/i;
/** Cover-label prefixes fused onto the title line ("Degree Project <title>"). */
const PREFIX_STRIP_RE =
  /^(?:degree project|working papers?(?: no\.? [\w-]+)?|findings of [^:]{2,80}:|draft of [^:]{2,80}:?)\s+/i;
/** Publisher boilerplate that out-longs real titles (no topic keywords). */
const BOILERPLATE_RE =
  /(draft form|distributed for purposes|without permission|all rights reserved|may not be reproduced|copies of .* available|grateful to|research assistance|funding for this research|previously circulated|do not cite|preliminary version)/i;
/** Lowercase particles that don't disqualify an author-name line. */
const NAME_PARTICLES_RE = /\b(de|van|von|der|bin|al|del|da|di|le|la)\b/gi;
/** "CHAPTER 7 Large Language Models" / "BAB 2 …" → group 1 is the real title. */
const CHAPTER_TITLE_RE = /^(?:chapter|bab)\s+\d+\s*[:–.-]?\s*(.{10,200})$/im;

function cleanPageMarkers(text: string): string {
  return (text ?? "").replace(/\[Page \d+\]\n?/g, " ");
}

function isEmailLine(s: string): boolean {
  return s.includes("@");
}

function isMostlyNumeric(s: string): boolean {
  const alnum = s.replace(/[^A-Za-z0-9]/g, "");
  if (!alnum) return true;
  const digits = (s.match(/\d/g) ?? []).length;
  return digits / Math.max(s.length, 1) > 0.4;
}

/**
 * Extract the document's own title from head-of-document text.
 * Strategy (generic, no topic lists):
 *  1. A "Chapter N <title>" line wins outright (edited volumes: the chapter
 *     title is the document, the book name is not).
 *  2. Else look at the block before "Abstract", skip cover/venue/boilerplate
 *     lines and author-name blobs, then take the longest substantial line,
 *     joining one wrapped continuation line.
 * Falls back to the first non-empty line, then the filename.
 */
export function extractTitleCandidate(text: string, filename: string): { title: string; method: string } {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
  const clean = cleanPageMarkers(text);
  const head = clean.slice(0, 4000);
  const chapterM = head.match(CHAPTER_TITLE_RE);
  if (chapterM) return { title: chapterM[1].trim().slice(0, 250), method: "chapter" };
  const absIdx = head.search(/\babstract\b/i);
  const scope = absIdx > 0 ? head.slice(0, absIdx) : head;
  const rawLines = scope.split("\n").map((l) => l.trim().replace(/\s+/g, " "));
  const stripped = rawLines.map((l) => l.replace(PREFIX_STRIP_RE, "").trim());
  const isNameBlob = (l: string): boolean => {
    // Person-name / affiliation lines: short, all-capitalized words, no
    // title paraphernalia (parens, digits, function words). Fully Title-Cased
    // paper titles without any lowercase word are a rare casualty here -
    // the on-demand page-1 assist covers them.
    if (/[()0-9]/.test(l) || l.length > 60) return false;
    const words = l.replace(NAME_PARTICLES_RE, "").split(/\s+/).filter(Boolean);
    return (
      words.length >= 2 && words.every((w) => /^[A-ZÀ-Þ][\w'’.,()-]*$/.test(w))
    );
  };
  const commaCount = (l: string): number => (l.match(/,/g) ?? []).length;
  /** Affiliation footnote markers fused onto the line ("g SDAIA-KFUPM …"). */
  const hasMarkerPrefix = (l: string): boolean => /^[a-z] [A-Z]/.test(l);
  const lines = stripped
    .filter((l) => l.length >= 12 && l.length <= 300)
    .filter(
      (l) =>
        !isEmailLine(l) && !isMostlyNumeric(l) && !TITLE_JUNK_RE.test(l) &&
        !BOILERPLATE_RE.test(l) && !isNameBlob(l) && !hasMarkerPrefix(l) &&
        commaCount(l) < 2,
    );
  // Prefer lines that do NOT look like venue/series names.
  const own = lines.filter((l) => !VENUE_HINT_RE.test(l));
  const pool = own.length ? own : lines;
  if (pool.length) {
    let best = pool[0];
    for (const l of pool) if (l.length > best.length) best = l;
    const rawIdx = stripped.indexOf(best);
    const looksTitleish = (s: string): boolean =>
      !!s && s.length >= 3 && s.length <= 300 && !isEmailLine(s) && !isMostlyNumeric(s) &&
      !TITLE_JUNK_RE.test(s) && !BOILERPLATE_RE.test(s) && !isNameBlob(s) &&
      !hasMarkerPrefix(s) && !VENUE_HINT_RE.test(s) && commaCount(s) < 2;
    // A wrapped title head that fell below the pool's 12-char floor (e.g.
    // "Research") is still joinable - length floor doesn't apply here.
    const looksContinuation = (s: string): boolean =>
      !!s && s.length >= 3 && s.length <= 60 && /^[A-Z0-9(]/.test(s) && !/[.!?]$/.test(s) &&
      !isEmailLine(s) && !isMostlyNumeric(s) && !TITLE_JUNK_RE.test(s) &&
      !BOILERPLATE_RE.test(s) && !isNameBlob(s) && !hasMarkerPrefix(s) &&
      !VENUE_HINT_RE.test(s) && commaCount(s) < 2;
    // Walk neighbours iteratively (titles wrap over 2–3 lines): backward
    // while the previous line looks like an unfinished title head (max 2),
    // then one short forward continuation. Generic shape checks only.
    const parts = [best];
    if (rawIdx >= 0) {
      for (let i = rawIdx - 1, n = 0; i >= 0 && n < 2; i--, n++) {
        const prev = stripped[i];
        if (!looksTitleish(prev) || prev.length > 120 || /[.!?]$/.test(prev)) break;
        if (parts.join(" ").length + prev.length + 1 > 250) break;
        parts.unshift(prev);
      }
      const nextRaw = rawIdx + 1 < stripped.length ? stripped[rawIdx + 1] : "";
      if (
        nextRaw && !pool.includes(nextRaw) && looksContinuation(nextRaw) &&
        parts.join(" ").length + nextRaw.length + 1 <= 250
      ) {
        parts.push(nextRaw);
      }
    }
    return { title: parts.join(" ").slice(0, 250), method: "heading" };
  }
  const firstLine = (clean.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "").slice(0, 200);
  if (firstLine.length > 20 && firstLine.length < 200) return { title: firstLine, method: "firstline" };
  return { title: base, method: "filename" };
}

/**
 * Conservative year extraction: only explicit imprint patterns
 * (© YYYY, Copyright YYYY, Date: YYYY-MM-DD). Never the first bare
 * 4-digit number in the body - that picks up timelines, version
 * histories, and reference lists instead of the publication year.
 */
export function extractYear(head: string): number | null {
  const h = (head ?? "").slice(0, 8000);
  const copy = h.match(/(©|copyright)\s*(©\s*)?((?:19|20)\d{2})/i);
  if (copy) return Number(copy[3]);
  const dated = h.match(/\bdate\s*[:–-]\s*((?:19|20)\d{2})(?:-\d{2}-\d{2})?/i);
  if (dated) return Number(dated[1]);
  const m = h.match(/((?:19|20)\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/);
  if (m) return Number(m[1]);
  return null;
}

/** First-page slice for the on-demand metadata-assist call. */
export function pageOneText(fullText: string, maxChars = 3000): string {
  return cleanPageMarkers(fullText).trim().slice(0, maxChars);
}

/** Everything preview needs to propose metadata, derived from raw text. */
export interface TextAnalysis {
  title: string;
  titleMethod: string;
  year: number | null;
  doi: string | null;
  isbn: string | null;
  pmid: string | null;
  documentType: string;
  textSnippet: string;
}

/**
 * Extract a normalized ISBN-10 or ISBN-13 from text (digits only, X allowed
 * as the ISBN-10 check digit). Returns null when no plausible ISBN is found.
 */
export function extractIsbn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/ISBN(?:-1[03])?\s*[:\s-]*\s*([0-9][0-9\-\s]{8,16}[0-9Xx])/i);
  if (!m) return null;
  const raw = m[1].replace(/[-\s]/g, "").toUpperCase();
  if (raw.length !== 10 && raw.length !== 13) return null;
  if (!/^\d{9}[\dX]$/.test(raw) && !/^\d{13}$/.test(raw)) return null;
  return raw;
}

/**
 * Extract a PubMed ID (PMID) from text. Looks for an explicit label so bare
 * numbers in the body are never misread as identifiers.
 */
export function extractPmid(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/PMID\s*[:#]?\s*(\d{5,9})/i) ?? text.match(/PubMed\s+ID\s*[:#]?\s*(\d{5,9})/i);
  return m ? m[1] : null;
}

/**
 * Single deterministic pass over extracted text. Callers (preview + worker)
 * share this so the main-thread and off-thread paths can never diverge.
 */
export function analyzeText(filename: string, text: string): TextAnalysis {
  const textSnippet = (text ?? "").slice(0, 2000);
  const titleCandidate = extractTitleCandidate(text ?? "", filename);
  return {
    title: titleCandidate.title,
    titleMethod: titleCandidate.method,
    year: extractYear(text ?? ""),
    doi: extractDoi((text ?? "").slice(0, 20000)),
    isbn: extractIsbn(text ?? ""),
    pmid: extractPmid(text ?? ""),
    documentType: classifyDocumentType(textSnippet, filename).docType,
    textSnippet,
  };
}
