// Port of core/ingestion/deduplication.py — algorithms preserved, infra dropped.
// Priority: SHA-256 → DOI → normalized title → author+year → fuzzy title ≥0.85.

export interface ProposedDoc {
  file_hash?: string | null;
  doi?: string | null;
  title?: string | null;
  authors?: string[];
  year?: number | string | null;
}

export interface ExistingDoc extends ProposedDoc {
  id: string;
}

export interface DuplicateHit {
  document: ExistingDoc;
  reason: "hash" | "doi" | "title_exact" | "author_year" | "title_fuzzy";
  confidence: number;
  label: string;
}

export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

export function normalizeAuthors(authors: string[] | undefined): string {
  if (!authors || authors.length === 0) return "";
  return authors
    .map((a) => a.toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

export function extractDoi(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = DOI_RE.exec(text);
  if (!m) return null;
  // Strip trailing punctuation the regex legitimately includes mid-DOI
  // ("/", ";", "(", ")") — must agree with openalex.cleanDoi, kept inline
  // here to avoid a dedup↔openalex import cycle.
  return m[0].toLowerCase().replace(/[.,;)\]]+$/, "") || null;
}

export function titleFuzzyScore(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  // Jaccard over bigrams + length penalty: dependency-free fuzzy match
  // approximating difflib's ratio for the ≥0.85 / ≥0.55 thresholds used.
  if (x === y) return 1;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter++;
  const denom = bx.size + by.size;
  if (denom === 0) return 0;
  return (2 * inter) / denom;
}

export function checkDuplicates(
  proposed: ProposedDoc,
  existingDocs: ExistingDoc[],
): DuplicateHit[] {
  const results: DuplicateHit[] = [];
  const ph = (proposed.file_hash ?? "").toLowerCase();
  const pdoi = (proposed.doi ?? "").toLowerCase().trim();
  const ptitle = normalizeTitle(proposed.title);
  const pauth = normalizeAuthors(proposed.authors);
  const pyear = proposed.year != null ? String(proposed.year) : "";

  for (const doc of existingDocs) {
    const eh = (doc.file_hash ?? "").toLowerCase();
    const edoi = (doc.doi ?? "").toLowerCase().trim();
    const etitle = normalizeTitle(doc.title);
    const eauth = normalizeAuthors(doc.authors);
    const eyear = doc.year != null ? String(doc.year) : "";

    if (ph && eh && ph === eh) {
      results.push({
        document: doc,
        reason: "hash",
        confidence: 1.0,
        label: "Identical file (SHA-256 match)",
      });
      continue;
    }
    if (pdoi && edoi && pdoi === edoi) {
      results.push({
        document: doc,
        reason: "doi",
        confidence: 0.98,
        label: "Same DOI",
      });
      continue;
    }
    if (ptitle && etitle && ptitle === etitle) {
      results.push({
        document: doc,
        reason: "title_exact",
        confidence: 0.92,
        label: "Identical title",
      });
      continue;
    }
    if (pauth && eauth && pyear && eyear && pauth === eauth && pyear === eyear) {
      results.push({
        document: doc,
        reason: "author_year",
        confidence: 0.78,
        label: "Same authors & year",
      });
      continue;
    }
    if (ptitle.length > 10 && etitle.length > 10) {
      const ratio = titleFuzzyScore(ptitle, etitle);
      if (ratio >= 0.85) {
        results.push({
          document: doc,
          reason: "title_fuzzy",
          confidence: Math.round(ratio * 100) / 100,
          label: `Similar title (${Math.round(ratio * 100)}% match)`,
        });
      }
    }
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
