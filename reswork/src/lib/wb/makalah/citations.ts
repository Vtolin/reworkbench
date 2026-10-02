// Makalah citation hygiene: alias mapping, leak stripping, detectors.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import type { SectionCitation, SectionOutput, SectionPassage } from "./types";

// ---------------------------------------------------------------------------
// Section Generator (once per subsection)
// ---------------------------------------------------------------------------

/**
 * Short opaque aliases (S1, S2, …) stand in for real document ids inside the
 * Section Generator prompt. A raw UUID *looks* like a citation key, which
 * invites the model to paste it into the prose; `S1` doesn't read that way.
 * Mapping is restored (then validated) on the way back out.
 */
export function aliasPassages(passages: SectionPassage[]): {
  aliased: SectionPassage[];
  toReal: Map<string, string>;
} {
  const seen = new Map<string, string>();
  const toReal = new Map<string, string>();
  let n = 0;
  for (const p of passages) {
    if (!seen.has(p.source_id)) {
      n += 1;
      seen.set(p.source_id, `S${n}`);
      toReal.set(`S${n}`, p.source_id);
    }
  }
  return {
    aliased: passages.map((p) => ({ ...p, source_id: seen.get(p.source_id)! })),
    toReal,
  };
}

/** Map alias citations back to real ids. Unknown aliases survive untouched so
 *  the citation validator flags them as hallucinated. */
export function resolveAliases(output: SectionOutput, toReal: Map<string, string>): SectionOutput {
  return {
    ...output,
    paragraphs: output.paragraphs.map((p) => ({
      ...p,
      citations: p.citations.map((c) => {
        const norm = normalizeAliasCitation(c);
        const real = toReal.get(norm.source_id);
        return real
          ? { source_id: real, page: norm.page ?? c.page }
          : { source_id: norm.source_id, page: norm.page ?? c.page };
      }),
    })),
  };
}

/**
 * Normalize an alias-shaped citation key: case-insensitive (`s2` → `S2`),
 * surrounding brackets stripped (`[S2]` → `S2`), embedded page markers
 * extracted (`S2, h. 47` → key `S2` + page 47). Non-alias keys pass through.
 */
const ALIAS_KEY_RE = /^\[?\s*S(\d+)\s*(?:[,;]\s*(?:p\.?|h\.?|hal\.?|halaman|pp?\.?)\s*(\d+))?\s*\]?$/i;

export function normalizeAliasCitation(c: SectionCitation): SectionCitation {
  const m = c.source_id.trim().match(ALIAS_KEY_RE);
  if (!m) return c;
  return {
    source_id: `S${Number(m[1])}`,
    page: c.page ?? (m[2] ? Number(m[2]) : null),
  };
}

const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PAREN_RE = new RegExp(`\\(\\s*(?:${UUID_SRC})\\s*(?:,\\s*p\\.?\\s*\\d+)?\\s*\\)`, "gi");
const UUID_RE = new RegExp(`\\b(?:${UUID_SRC})\\b`, "gi");
// Page markers in several languages — the model localizes them (Indonesian
// "h." for halaman turned up in the wild as "[S2, h. 5]").
const PAGE_MARK_SRC = "(?:p\\.?|h\\.?|hal\\.?|halaman|pp?\\.?)";
const ALIAS_LEAK_RE = new RegExp(
  `\\[\\s*S\\d+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
  `|\\(\\s*S\\d+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
  "gi",
);
// Multi-alias echoes: "[S2; S5]", "(S2, S5, h. 3)".
const ALIAS_MULTI_RE = new RegExp(
  `\\[\\s*S\\d+(?:\\s*[;,]\\s*S\\d+)+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
  `|\\(\\s*S\\d+(?:\\s*[;,]\\s*S\\d+)+\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
  "gi",
);
// Bare inline echoes without brackets: "…populasi S2, h. 47 …"
const ALIAS_BARE_RE = new RegExp(`\\bS\\d+\\s*,\\s*${PAGE_MARK_SRC}\\s*\\d+`, "gi");
// Leftover debris the strict shapes miss ("[S2;]", "[S1,]"). Runs AFTER the
// strict patterns above; the [^A-Za-z…] middle keeps prose like "(S1 orang)" safe.
const ALIAS_DEBRIS_RE = /[[(]\s*S\d+[^A-Za-z[\]()]*[\])]/gi;
// Bare numeric brackets the model emits as pseudo-citations ("[483]",
// "[6, 21]" — IEEE-looking echoes from small models). Never legit here:
// attribution lives ONLY in the `citations` array, and rendered cites always
// carry a title ("[Title, h. X]"), never a bare number. Paren-form "(483)"
// is deliberately NOT matched — bare paren numbers collide with real prose.
const NUMERIC_CITE_RE = /\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]/g;
// Empty placeholder brackets the model emits when it wants a citation but
// has none ("[]", "[;]", "( )"). Never legit in academic prose.
const EMPTY_CITE_RE = /[[(]\s*[;,\s]*[\])]/g;
// (Smith, 2020) / (Faridah et al., 2021) / (Smith & Jones, 2020) shapes only:
// the comma (or et-al/&-form) requirement keeps legit refs like (UUD 1945) safe.
const AUTHORYEAR_LEAK_RE = /\(\s*[A-Z][\w\-]+(?:\s+et\.?\s*al\.?)?\s*,\s*\d{4}[a-z]?\s*\)|\(\s*[A-Z][\w\-]+\s+(?:&\s*[A-Z][\w\-]+|and\s+[A-Z][\w\-]+|et\.?\s*al\.?)\s*,?\s*\d{4}[a-z]?\s*\)/g;

/**
 * Belt-and-suspenders: strip citation-shaped leakage the model baked into
 * prose (raw UUIDs, alias echoes like `(S1, p. 3)`, bare numeric echoes like
 * `[483]` / `[6, 21]`, author-year echoes like `(Faridah et al., 2021)`).
 * Attribution lives in `citations`, never in text.
 */
export function stripLeakedCitations(text: string): string {
  return text
    .replace(UUID_PAREN_RE, "")
    .replace(UUID_RE, "")
    .replace(ALIAS_MULTI_RE, "")
    .replace(ALIAS_LEAK_RE, "")
    .replace(ALIAS_DEBRIS_RE, "")
    .replace(ALIAS_BARE_RE, "")
    .replace(NUMERIC_CITE_RE, "")
    .replace(EMPTY_CITE_RE, "")
    .replace(AUTHORYEAR_LEAK_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/**
 * Chunk storage prefixes every chunk with a "[Page N]" marker. Inside a
 * section-generation prompt that marker reads as a citation key, and models
 * copy it into `citations` as source_id "Page" (rendered "[Page, h. 1]" —
 * validator-flagged, but ugly). Strip markers from passage text at
 * prompt-build time only; stored chunks are untouched.
 */
export function cleanPassageForPrompt(text: string): string {
  return (text ?? "").replace(/\[Page \d+\]\n?/gi, "").trim();
}

/**
 * Strip title echoes (`[Full Paper Title, h. 1]`, `(Full Paper Title)`): the
 * model sometimes cites by title string instead of alias, usually echoing a
 * title it saw inside passage text or from training data. Matching is exact
 * (case-insensitive) against known source titles, so only genuine echoes go —
 * and only titles long enough (≥24 chars) that a prose collision is implausible.
 */
export function stripTitleEchoes(text: string, titles: string[]): string {
  const pats = [...new Set(titles.map((t) => (t ?? "").trim()))]
    .filter((t) => t.length >= 24)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const t of pats) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(
        `\\[\\s*${esc}\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\]` +
        `|\\(\\s*${esc}\\s*(?:,\\s*${PAGE_MARK_SRC}\\s*\\d+)?\\s*\\)`,
        "gi",
      ),
      "",
    );
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/**
 * Post-generation defect detectors (deterministic, topic-generic).
 * Used for one bounded correction retry: the model gets its defects listed
 * back and one chance to fix them. Still app-controlled (max 1 extra call).
 */

/** Source-gap meta-sentences that belong in `gaps`, never in paragraph text.
 *  Narrowly scoped to source-referencing phrases — paper-scope statements
 *  ("Penelitian ini tidak akan membahas…") are legitimate and NOT matched. */
const GAP_LEAK_PATTERNS: RegExp[] = [
  /tidak\s+ditemukan\s+dalam\s+sumber/i,
  /tidak\s+terdapat\s+dalam\s+(sumber|kutipan)/i,
  /tidak\s+ditemukan\s+dalam\s+kutipan/i,
  /sumber\s+tidak\s+(memuat|menyediakan|mencakup|memberikan)/i,
  /dokumen\s+acuan\s+tidak/i,
  /literatur\s+yang\s+tersedia[^.]{0,80}belum\s+merinci/i,
  /not\s+found\s+in\s+the\s+(source|passage|citation)/i,
  /not\s+mentioned\s+in\s+the\s+(source|passage|citation)/i,
  /(sources?|passages?)\s+do\s+not\s+provide/i,
  /no\s+information[^.]{0,60}in\s+the\s+passages/i,
];

export function containsGapLeak(text: string): boolean {
  const t = text ?? "";
  return GAP_LEAK_PATTERNS.some((re) => re.test(t));
}

/** True when prose still carries citation-shaped leakage (aliases, bare
 *  numeric brackets, UUIDs, author-year echoes, empty placeholders). Runs on
 *  raw model text BEFORE stripping — after stripping there is nothing left
 *  to detect. */
export function hasCitationLeak(text: string): boolean {
  const t = text ?? "";
  // All leak patterns are global (/g/): reset lastIndex before each test
  // since .test() on a /g/ regex is stateful.
  for (const re of [ALIAS_MULTI_RE, ALIAS_LEAK_RE, ALIAS_BARE_RE, NUMERIC_CITE_RE, UUID_RE, EMPTY_CITE_RE, AUTHORYEAR_LEAK_RE]) {
    re.lastIndex = 0;
    if (re.test(t)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/** Citations with no usable source key (renders as "[, 61]").
 *  Page hallucinations are deliberately NOT judged by absolute size here:
 *  printed-page corpora (e.g. ACL Findings pp. 12834–12854) legitimately
 *  exceed any fixed cap, so a `>5000` rule would false-positive and make the
 *  correction retry "fix" a correct page. Wrong pages are caught exactly by
 *  badPages instead (the cited page must occur in the retrieved passages for
 *  that source; page-less sources stay unverifiable and unflagged). */
export function hasEmptyCitation(output: SectionOutput): boolean {
  for (const p of output.paragraphs ?? []) {
    for (const c of p.citations ?? []) {
      const key = (c.source_id ?? "").trim();
      if (!key) return true;
      if (/^[,;\s\d]+$/.test(key)) return true;
    }
  }
  return false;
}
