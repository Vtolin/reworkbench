// Port of core/citations/engine.py + core/legal/extraction.py (deterministic
// parts). CSL rendering stays simple server-side; the browser formats
// plain-text citations for chat answers and the research trail.

export interface CslItem {
  id: string;
  type: string;
  title?: string;
  author?: Array<{ family: string; given?: string }>;
  issued?: { "date-parts": number[][] };
  containerTitle?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  DOI?: string;
  abstract?: string;
}

export function docToCslItem(doc: {
  id: string;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  doi?: string | null;
  abstract?: string | null;
  document_type?: string | null;
}): CslItem {
  const type =
    doc.document_type === "legal"
      ? "legal_case"
      : doc.document_type === "thesis"
        ? "thesis"
        : "article-journal";
  const author = (doc.authors ?? []).map((full) => {
    const parts = full.trim().split(/\s+/);
    const family = parts.pop() ?? full;
    return { family, given: parts.join(" ") || undefined };
  });
  return {
    id: doc.id,
    type,
    title: doc.title ?? undefined,
    author: author.length ? author : undefined,
    issued: doc.year ? { "date-parts": [[doc.year]] } : undefined,
    containerTitle: doc.journal ?? undefined,
    volume: doc.volume ?? undefined,
    issue: doc.issue ?? undefined,
    page: doc.pages ?? undefined,
    publisher: doc.publisher ?? undefined,
    DOI: doc.doi ?? undefined,
    abstract: doc.abstract ?? undefined,
  };
}

// Minimal plain-text renderer (APA-ish). Full CSL styles remain a Phase 7
// server enhancement; this keeps chat citations truthful without citeproc.
export function renderCitationPlain(item: CslItem): string {
  const authors = (item.author ?? [])
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .join(", ");
  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? "n.d.";
  const venue = item.containerTitle ? ` ${item.containerTitle}` : "";
  const vol = item.volume ? ` ${item.volume}` : "";
  const pages = item.page ? `, ${item.page}` : "";
  return `${authors ? authors + " " : ""}(${year}). ${item.title ?? "Untitled"}.${venue}${vol}${pages}.`.trim();
}

export function formatEvidenceCitation(opts: {
  title: string;
  page?: number | null;
  section?: string | null;
  year?: number | null;
}): string {
  const bits = [opts.title];
  if (opts.page) bits.push(`Page ${opts.page}`);
  if (opts.section) bits.push(opts.section);
  if (opts.year) bits.push(String(opts.year));
  return bits.join(", ");
}

// Deterministic legal identifier extraction (port of core/legal/extraction.py
// regexes, browser-safe subset).
const PUU_RE = /\d{1,3}\/PUU-[XVI]+\/\d{4}/gi;
const PASAL_RE = /pasal\s+\d+[A-Z]?(?:\s+ayat\s*\(?\d+\)?)?/gi;

export function extractCitedIdentifiers(text: string): Array<{ identifier: string; kind: "case" | "statute" | "article" }> {
  const out: Array<{ identifier: string; kind: "case" | "statute" | "article" }> = [];
  for (const m of text.matchAll(PUU_RE)) {
    out.push({ identifier: m[0].toUpperCase(), kind: "case" });
  }
  for (const m of text.matchAll(PASAL_RE)) {
    out.push({ identifier: m[0].replace(/\s+/g, " ").trim(), kind: "article" });
  }
  return out;
}
