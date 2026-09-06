// Browser CSL citation engine (port of core/citations/engine.py).
// Rendering via citeproc-js (npm `citeproc`) with the same vendored .csl
// styles; BibTeX/RIS serializers ported 1:1. Style fetch + custom XML are
// cached in localStorage (per-device); default style likewise.
import { Engine } from "citeproc";
import type { HydratedDoc } from "../wb/library";

export const KNOWN_STYLES = [
  "apa",
  "chicago-author-date",
  "modern-language-association",
  "oscola",
  "bluebook-law-review",
  "harvard-cite-them-right",
  "australian-guide-to-legal-citation",
] as const;

const LS_STYLES = "rw.csl_styles.v1"; // {id: xml}
const LS_DEFAULT = "rw.csl_default.v1";

const SOURCE_TYPE_TO_CSL: Record<string, string> = {
  journal: "article-journal",
  article: "article-journal",
  empirical: "article-journal",
  survey: "article-journal",
  general: "article-journal",
  legal: "legal_case",
  legal_case: "legal_case",
  thesis: "thesis",
  report: "report",
  book: "book",
  webpage: "webpage",
  web: "webpage",
};

export interface CslItem {
  id: string;
  type: string;
  title?: string;
  author?: Array<{ family: string; given?: string }>;
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  DOI?: string;
  abstract?: string;
  authority?: string;
  number?: string;
  URL?: string;
}

function parseAuthor(name: string): { family: string; given?: string } | null {
  const n = (name || "").trim();
  if (!n) return null;
  if (n.includes(",")) {
    const [family, given] = n.split(",", 2);
    return { family: family.trim(), given: given.trim() || undefined };
  }
  const parts = n.split(/\s+/);
  if (parts.length === 1) return { family: parts[0] };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

export function docToCslItem(doc: HydratedDoc): CslItem {
  const item: CslItem = {
    id: `doc-${doc.id}`,
    type: SOURCE_TYPE_TO_CSL[doc.document_type ?? ""] ?? "article",
    title: doc.title || doc.original_filename || "Untitled",
    author: doc.authors.map(parseAuthor).filter((a): a is { family: string; given?: string } => !!a),
  };
  if (doc.journal) item["container-title"] = doc.journal;
  if (doc.volume) item.volume = doc.volume;
  if (doc.issue) item.issue = doc.issue;
  if (doc.pages) item.page = doc.pages;
  if (doc.publisher) item.publisher = doc.publisher;
  if (doc.doi) item.DOI = doc.doi;
  if (doc.abstract) item.abstract = doc.abstract;
  if (doc.year) item.issued = { "date-parts": [[doc.year]] };
  const md = doc.citation_metadata ?? {};
  if (typeof md.court === "string") item.authority = md.court;
  if (typeof md.case_number === "string") item.number = md.case_number;
  if (typeof md.url === "string") item.URL = md.url;
  return item;
}

async function loadStyleXml(styleId: string): Promise<string> {
  const id = (styleId || "apa").toLowerCase();
  try {
    const cached = JSON.parse(localStorage.getItem(LS_STYLES) ?? "{}") as Record<string, string>;
    if (cached[id]) return cached[id];
  } catch {
    /* ignore */
  }
  const res = await fetch(`/csl/${id}.csl`);
  if (res.ok) return res.text();
  const apa = await fetch(`/csl/apa.csl`);
  if (!apa.ok) throw new Error("No CSL styles available");
  return apa.text();
}

async function loadLocale(): Promise<string> {
  const res = await fetch("/csl/locales-en-US.xml");
  if (!res.ok) throw new Error("CSL locale missing");
  return res.text();
}

export function styleTitleFromXml(xml: string, fallback: string): string {
  const m = xml.slice(0, 4000).match(/<title>([^<]+)<\/title>/);
  return m ? m[1].trim() : fallback;
}

export async function listStyles(): Promise<{ styles: Array<{ id: string; title: string; custom?: boolean }>; default: string }> {
  const styles: Array<{ id: string; title: string; custom?: boolean }> = [];
  for (const id of KNOWN_STYLES) {
    try {
      const xml = await loadStyleXml(id);
      styles.push({ id, title: styleTitleFromXml(xml, id) });
    } catch {
      /* skip missing */
    }
  }
  try {
    const cached = JSON.parse(localStorage.getItem(LS_STYLES) ?? "{}") as Record<string, string>;
    for (const id of Object.keys(cached)) {
      if (!styles.some((s) => s.id === id)) {
        styles.push({ id, title: styleTitleFromXml(cached[id], id), custom: true });
      }
    }
    if (cached.custom) {
      if (!styles.some((s) => s.id === "custom")) {
        styles.push({ id: "custom", title: styleTitleFromXml(cached.custom, "Custom CSL"), custom: true });
      }
    }
  } catch {
    /* ignore */
  }
  return { styles, default: getDefaultStyle() };
}

export function getDefaultStyle(): string {
  try {
    return localStorage.getItem(LS_DEFAULT) ?? "apa";
  } catch {
    return "apa";
  }
}

export function setDefaultStyle(style: string): void {
  try {
    localStorage.setItem(LS_DEFAULT, style);
  } catch {
    /* ignore */
  }
}

function renderWithEngine(items: CslItem[], styleXml: string, localeXml: string): string[] {
  const byId: Record<string, CslItem> = {};
  for (const it of items) byId[it.id] = it;
  const sys = {
    retrieveLocale: () => localeXml,
    retrieveItem: (id: string | number) => ((byId[String(id)] ?? {}) as unknown) as Record<string, unknown>,
  };
  const citeproc = new Engine(sys, styleXml, "en-US");
  citeproc.updateItems(items.map((i) => i.id));
  const [, entries] = citeproc.makeBibliography();
  // citeproc-js returns HTML; strip tags for plain text (matches old `formatter.plain`).
  return entries.map((e) => e.replace(/<[^>]+>/g, "").replace(/&#38;/g, "&").replace(/&amp;/g, "&").trim());
}

export async function renderCitation(item: CslItem, styleId?: string): Promise<string> {
  const [styleXml, localeXml] = await Promise.all([
    loadStyleXml(styleId ?? getDefaultStyle()),
    loadLocale(),
  ]);
  const out = renderWithEngine([item], styleXml, localeXml);
  return out[0] ?? "";
}

export async function renderBibliography(items: CslItem[], styleId?: string): Promise<string[]> {
  if (!items.length) return [];
  const [styleXml, localeXml] = await Promise.all([
    loadStyleXml(styleId ?? getDefaultStyle()),
    loadLocale(),
  ]);
  return renderWithEngine(items, styleXml, localeXml);
}

export async function fetchStyleFromRepo(name: string): Promise<{ id: string; title: string }> {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Invalid style name");
  const res = await fetch(`https://raw.githubusercontent.com/citation-style-language/styles/master/${id}.csl`);
  if (!res.ok) throw new Error(`Style '${id}' not found in the CSL repository`);
  const xml = await res.text();
  if (!xml.includes("<style")) throw new Error("Downloaded file is not a CSL style");
  const cached = JSON.parse(localStorage.getItem(LS_STYLES) ?? "{}") as Record<string, string>;
  cached[id] = xml;
  localStorage.setItem(LS_STYLES, JSON.stringify(cached));
  return { id, title: styleTitleFromXml(xml, id) };
}

export function saveCustomStyle(xml: string): void {
  const v = (xml || "").trim();
  if (!v || !v.includes("<style")) throw new Error("Not a CSL style (missing <style>)");
  const cached = JSON.parse(localStorage.getItem(LS_STYLES) ?? "{}") as Record<string, string>;
  cached.custom = v;
  localStorage.setItem(LS_STYLES, JSON.stringify(cached));
}

// Serializers (ports of bibtex_entry / ris_entry) ------------------------------
export function bibtexEntry(doc: HydratedDoc): string {
  const authors = doc.authors.join(" and ");
  const fields = [`title={${doc.title || ""}}`];
  if (authors) fields.push(`author={${authors}}`);
  if (doc.journal) fields.push(`journal={${doc.journal}}`);
  if (doc.year) fields.push(`year={${doc.year}}`);
  if (doc.volume) fields.push(`volume={${doc.volume}}`);
  if (doc.issue) fields.push(`number={${doc.issue}}`);
  if (doc.pages) fields.push(`pages={${doc.pages}}`);
  if (doc.publisher) fields.push(`publisher={${doc.publisher}}`);
  if (doc.doi) fields.push(`doi={${doc.doi}}`);
  if (doc.abstract) fields.push(`abstract={${doc.abstract}}`);
  let entryType = "misc";
  if (doc.document_type !== "legal") {
    if (doc.journal) entryType = "article";
    else if (doc.document_type === "thesis") entryType = "phdthesis";
    else if (doc.publisher) entryType = "book";
  }
  return `@${entryType}{doc${doc.id},\n  ${fields.join(",\n  ")}\n}`;
}

export function risEntry(doc: HydratedDoc): string {
  const lines = ["TY  - JOUR"];
  for (const a of doc.authors) lines.push(`AU  - ${a}`);
  if (doc.title) lines.push(`TI  - ${doc.title}`);
  if (doc.year) lines.push(`PY  - ${doc.year}`);
  if (doc.journal) lines.push(`JO  - ${doc.journal}`);
  if (doc.volume) lines.push(`VL  - ${doc.volume}`);
  if (doc.issue) lines.push(`IS  - ${doc.issue}`);
  if (doc.pages) lines.push(`SP  - ${doc.pages}`);
  if (doc.publisher) lines.push(`PB  - ${doc.publisher}`);
  if (doc.doi) lines.push(`DO  - ${doc.doi}`);
  if (doc.abstract) lines.push(`AB  - ${doc.abstract}`);
  lines.push("ER  - ");
  return lines.join("\n");
}

export function plainCitation(doc: HydratedDoc, locator?: string): string {
  const bits = [doc.original_filename || doc.title];
  if (doc.year) bits.push(String(doc.year));
  const base = bits.filter(Boolean).join(", ");
  return locator ? `${base} (${locator})` : base;
}
