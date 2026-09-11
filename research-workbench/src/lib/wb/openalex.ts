// Browser-side OpenAlex metadata provider (port of core/metadata/providers.py).
// Free, no key. Best-effort: failures degrade to local extraction, never fatal.
import { titleFuzzyScore } from "@/lib/ingestion/dedup";

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
  const res = await fetch(`${OPENALEX_BASE}/works/https://doi.org/${encodeURIComponent(clean)}`);
  if (!res.ok) return null;
  return normalizeOpenAlexWork(await res.json(), DOI_MATCH_CONFIDENCE);
}

export async function searchByTitle(title: string, authors: string[] = []): Promise<MetadataCandidate[]> {
  if (!title.trim()) return [];
  const res = await fetch(`${OPENALEX_BASE}/works?search=${encodeURIComponent(title)}&per-page=5`);
  if (!res.ok) throw new Error(`OpenAlex lookup failed: ${res.status}`);
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

// Orchestrator (port of fetch_metadata): DOI hit → title candidates → local fallback.
export async function fetchMetadata(opts: {
  doi?: string | null;
  title?: string | null;
  authors?: string[];
  localFields?: Parameters<typeof localCandidate>[0];
}): Promise<{ proposal: MetadataCandidate; candidates: MetadataCandidate[]; error: string | null; offline: boolean }> {
  const localFields = opts.localFields ?? {};
  let error: string | null = null;
  const candidates: MetadataCandidate[] = [];
  if (opts.doi) {
    try {
      const hit = await fetchByDoi(opts.doi);
      if (hit) return { proposal: hit, candidates: [], error: null, offline: false };
    } catch (e) {
      error = e instanceof Error ? e.message : "OpenAlex lookup failed";
    }
  }
  if (opts.title) {
    try {
      candidates.push(...(await searchByTitle(opts.title, opts.authors ?? [])));
    } catch (e) {
      error = e instanceof Error ? e.message : "OpenAlex lookup failed";
    }
  }
  const best = candidates.length ? [...candidates].sort((a, b) => b.confidence - a.confidence)[0] : null;
  // Generic confidence gate: a low-confidence "best" match is worse than no
  // match, because accepting it locks wrong title/year/journal into the
  // document row (and later into Daftar Pustaka). Fall back to local and
  // keep the candidates so the human can pick manually.
  if (best && best.confidence >= OPENALEX_MIN_CONFIDENCE)
    return { proposal: best, candidates, error, offline: false };
  return { proposal: localCandidate(localFields), candidates, error, offline: error != null };
}
