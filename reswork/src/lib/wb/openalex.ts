// Browser-side OpenAlex metadata provider (port of core/metadata/providers.py).
// Free, no key. Best-effort: failures degrade to local extraction, never fatal.
import { titleFuzzyScore } from "@/lib/ingestion/dedup";
import { HttpStatusError, fetchWithTimeout, withRetry } from "@/lib/async/net";

// External-call policy (Task N): OpenAlex is a free idempotent GET API, so a
// single bounded retry on retryable failures (timeout / network / 429 / 5xx)
// is safe; 404s and other 4xx fail fast with no retry. The DOI lookup gets a
// timeout but no retry — a miss degrades to title search anyway. 20s
// deadline: metadata lookup runs in the background of an upload preview,
// never on a hot path.
const OPENALEX_TIMEOUT_MS = 20_000;

function openalexFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, undefined, OPENALEX_TIMEOUT_MS);
}

export interface MetadataCandidate {
  source: string;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  abstract: string | null;
  document_type: string | null;
  confidence: number;
  extras: Record<string, unknown>;
}

const OPENALEX_BASE = "https://api.openalex.org";
export const DOI_MATCH_CONFIDENCE = 0.97;
/**
 * Minimum title-match confidence for auto-accepting an OpenAlex candidate.
 * Below this the caller should fall back to local extraction and let the
 * human pick from `candidates` manually. This is deliberately generic
 * (no topic lists): it only measures "does the record match what we asked".
 */
export const OPENALEX_MIN_CONFIDENCE = 0.65;

export function cleanDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  let v = doi.trim().toLowerCase().replace(/[.,;)\]]+$/, "");
  v = v.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "");
  return v || null;
}

function formatPages(fp: unknown, lp: unknown): string | null {
  const a = fp != null && String(fp).trim() ? String(fp).trim() : null;
  const b = lp != null && String(lp).trim() ? String(lp).trim() : null;
  if (a && b) return `${a}-${b}`;
  return a ?? b;
}

function reconstructAbstract(inverted: Record<string, number[]> | null, maxChars = 2000): string | null {
  if (!inverted) return null;
  const pos: Record<number, string> = {};
  for (const [word, list] of Object.entries(inverted)) {
    for (const p of list) pos[p] = word;
  }
  const text = Object.keys(pos)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => pos[i])
    .join(" ");
  return text.slice(0, maxChars) || null;
}

const TYPE_MAP: Record<string, string> = { review: "survey", dissertation: "thesis" };

export function normalizeOpenAlexWork(work: Record<string, unknown>, confidence: number | null): MetadataCandidate {
  const ids = (work.ids as Record<string, string>) ?? {};
  const biblio = (work.biblio as Record<string, unknown>) ?? {};
  const primary = (work.primary_location as Record<string, unknown>) ?? {};
  const src = (primary.source as Record<string, unknown>) ?? {};
  const authors = ((work.authorships as Array<{ author?: { display_name?: string } }>) ?? [])
    .map((a) => a.author?.display_name?.trim() ?? "")
    .filter(Boolean);
  const oaType = String(work.type ?? "").toLowerCase();
  return {
    source: "openalex",
    title: (work.title as string) ?? null,
    authors,
    year: typeof work.publication_year === "number" ? work.publication_year : null,
    doi: cleanDoi(ids.doi ?? (work.doi as string)),
    journal: (src.display_name as string) ?? null,
    volume: biblio.volume != null ? String(biblio.volume) : null,
    issue: biblio.issue != null ? String(biblio.issue) : null,
    pages: formatPages(biblio.first_page, biblio.last_page),
    publisher: (src.host_organization_name as string) ?? null,
    abstract: reconstructAbstract(work.abstract_inverted_index as Record<string, number[]> | null),
    document_type: TYPE_MAP[oaType] ?? null,
    confidence: confidence ?? 0,
    extras: {
      openalex_id: work.id,
      openalex_type: oaType,
      cited_by_count: work.cited_by_count,
      is_oa: (work.open_access as Record<string, unknown> | null)?.is_oa,
    },
  };
}

function firstAuthorSurname(author: string): string {
  const parts = author.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : "";
}

export async function fetchByDoi(doi: string): Promise<MetadataCandidate | null> {
  const clean = cleanDoi(doi);
  if (!clean) return null;
  const res = await openalexFetch(`${OPENALEX_BASE}/works/https://doi.org/${encodeURIComponent(clean)}`);
  if (!res.ok) return null;
  return normalizeOpenAlexWork(await res.json(), DOI_MATCH_CONFIDENCE);
}

export async function fetchByIsbn(isbn: string): Promise<MetadataCandidate | null> {
  const clean = (isbn ?? "").replace(/[-\s]/g, "").toUpperCase();
  if (!clean || (clean.length !== 10 && clean.length !== 13)) return null;
  const res = await openalexFetch(`https://openlibrary.org/search.json?isbn=${encodeURIComponent(clean)}&limit=1`);
  if (!res.ok) return null;
  const data = (await res.json()) as { docs?: Array<Record<string, unknown>> };
  const doc = (data.docs ?? [])[0];
  if (!doc || !doc.title) return null;
  const authors = Array.isArray(doc.author_name)
    ? (doc.author_name as unknown[]).map(String).filter(Boolean)
    : [];
  const year =
    typeof doc.first_publish_year === "number" ? (doc.first_publish_year as number) : null;
  const publishers = Array.isArray(doc.publisher) ? (doc.publisher as unknown[]).map(String) : [];
  return {
    source: "openlibrary",
    title: String(doc.title),
    authors,
    year,
    doi: null,
    journal: null,
    volume: null,
    issue: null,
    pages:
      typeof doc.number_of_pages_median === "number"
        ? String(doc.number_of_pages_median)
        : null,
    publisher: publishers[0] ?? null,
    abstract: null,
    document_type: null,
    confidence: 0.85,
    extras: { isbn: clean, openlibrary_key: doc.key },
  };
}

export async function fetchByPmid(pmid: string): Promise<MetadataCandidate | null> {
  const clean = (pmid ?? "").trim();
  if (!/^\d{5,9}$/.test(clean)) return null;
  const res = await openalexFetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(clean)}&retmode=json`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: Record<string, Record<string, unknown>> };
  const result = data.result?.[clean];
  if (!result || !result.title) return null;
  const authors = Array.isArray(result.authors)
    ? (result.authors as Array<{ name?: string }>).map((a) => a.name ?? "").filter(Boolean)
    : [];
  const yearMatch = String(result.pubdate ?? "").match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  const articleIds = Array.isArray(result.articleids)
    ? (result.articleids as Array<{ idtype?: string; value?: string }>)
    : [];
  const doiEntry = articleIds.find((a) => a.idtype === "doi");
  return {
    source: "pubmed",
    title: String(result.title),
    authors,
    year,
    doi: cleanDoi(doiEntry?.value),
    journal: typeof result.source === "string" ? result.source : null,
    volume: typeof result.volume === "string" ? result.volume : null,
    issue: typeof result.issue === "string" ? result.issue : null,
    pages: typeof result.pages === "string" ? result.pages : null,
    publisher: null,
    abstract: null,
    document_type: "empirical",
    confidence: 0.9,
    extras: { pmid: clean },
  };
}
export async function searchByTitle(title: string, authors: string[] = []): Promise<MetadataCandidate[]> {
  if (!title.trim()) return [];
  // Single retry layer (max 2 fetches): network/timeout/429/5xx retry, 4xx
  // fail fast. DOI lookup above needs none — a miss degrades to this path.
  const res = await withRetry(async () => {
    const r = await openalexFetch(`${OPENALEX_BASE}/works?search=${encodeURIComponent(title)}&per-page=5`);
    // HttpStatusError keeps the established message text (callers surface
    // it), while carrying the status so withRetry retries 429/5xx, not 4xx.
    if (!r.ok) throw new HttpStatusError(r.status, `OpenAlex lookup failed: ${r.status}`);
    return r;
  }, { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2000 });
  const data = await res.json();
  const out: MetadataCandidate[] = [];
  for (const work of (data.results ?? []) as Array<Record<string, unknown>>) {
    const cand = normalizeOpenAlexWork(work, null);
    if (!cand.title) continue;
    let conf = titleFuzzyScore(title, cand.title);
    if (authors.length) {
      const q = firstAuthorSurname(authors[0]);
      if (q && cand.authors.some((a) => firstAuthorSurname(a) === q)) conf = Math.min(conf + 0.05, 0.99);
    }
    cand.confidence = Math.round(conf * 100) / 100;
    out.push(cand);
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

export function localCandidate(fields: {
  title?: string | null;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  journal?: string | null;
  document_type?: string | null;
  jurisdiction?: string | null;
}): MetadataCandidate {
  return {
    source: "local",
    title: fields.title ?? null,
    authors: fields.authors ?? [],
    year: fields.year ?? null,
    doi: cleanDoi(fields.doi),
    journal: fields.journal ?? null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    abstract: null,
    document_type: fields.document_type ?? null,
    confidence: 0.45,
    extras: { jurisdiction: fields.jurisdiction, label: "Extracted from the file itself - verify manually" },
  };
}

export async function fetchMetadata(opts: {
  doi?: string | null;
  isbn?: string | null;
  pmid?: string | null;
  title?: string | null;
  authors?: string[];
  localFields?: Parameters<typeof localCandidate>[0];
}): Promise<{ proposal: MetadataCandidate; candidates: MetadataCandidate[]; error: string | null; offline: boolean }> {
  const localFields = opts.localFields ?? {};
  let error: string | null = null;
  const candidates: MetadataCandidate[] = [];
  let proposal: MetadataCandidate | null = null;
  let offline = false;

  const tryLookup = async (fn: () => Promise<MetadataCandidate | null>) => {
    try {
      const hit = await fn();
      if (hit) proposal = hit;
    } catch (e) {
      error = e instanceof Error ? e.message : "Metadata lookup failed";
    }
  };

  if (opts.doi && !proposal) await tryLookup(() => fetchByDoi(opts.doi!));
  if (opts.isbn && !proposal) await tryLookup(() => fetchByIsbn(opts.isbn!));
  if (opts.pmid && !proposal) await tryLookup(() => fetchByPmid(opts.pmid!));

  if (!proposal && opts.title) {
    try {
      candidates.push(...(await searchByTitle(opts.title, opts.authors ?? [])));
    } catch (e) {
      error = e instanceof Error ? e.message : "OpenAlex lookup failed";
    }
  }
  const best = candidates.length ? [...candidates].sort((a, b) => b.confidence - a.confidence)[0] : null;
  if (!proposal && best && best.confidence >= OPENALEX_MIN_CONFIDENCE) proposal = best;

  if (proposal) {
    return { proposal, candidates, error, offline };
  }
  if (error) offline = true;
  return { proposal: localCandidate(localFields), candidates, error, offline };
}
