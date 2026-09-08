// Port of mlra/summarization.py + output_cleanup.py (browser-safe subset).
//
// 3-stage whole-document pipeline:
//   MAP (fast model) extracts tagged bullet facts per chunk ->
//   REDUCE (mid model) consolidates/dedupes across rounds ->
//   SYNTHESIS (heavy model) writes the final doc-type-aware narrative.
// In parallel, a deterministic regex layer pulls percentages, dates,
// sample sizes, Indonesian legal citations, and data sources straight
// from the source text (no LLM), so those facts are exact regardless
// of what the models do. A LaTeX/cleanup safety net scrubs generation
// artifacts ([THIS WORK]/[CITED] tags, literal \n) while preserving
// math delimiters for the KaTeX frontend.
//
// NOT ported (needs native PDF access): PyMuPDF table finder
// (tables_section), tiktoken counting (chars/3.2 fallback instead).

export interface PipeChunk {
  content: string;
  page: number | null;
  section: string | null;
}

// ---------------------------------------------------------------------------
// Token counting (chars/3.2 fallback — tiktoken is unavailable in browser)
// ---------------------------------------------------------------------------
export function countTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3.2));
}

// ---------------------------------------------------------------------------
// Sentence splitting — dependency-free, abbreviation-aware
// ---------------------------------------------------------------------------
const ABBREVIATIONS = [
  "et al.", "approx.", "sept.", "supp.", "figs.", "refs.", "eqs.",
  "fig.", "sec.", "vol.", "app.", "tbl.", "ref.", "e.g.", "i.e.",
  "etc.", "vs.", "cf.", "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.",
  "jr.", "st.", "jan.", "feb.", "mar.", "apr.", "jun.", "jul.", "aug.",
  "sep.", "oct.", "nov.", "dec.", "cir.", "stat.", "cfr.", "usc.",
  "eq.", "pp.", "no.", "al.", "ch.", "mg.", "kg.", "ml.", "mcg.", "v.",
].sort((a, b) => b.length - a.length);

const CANDIDATE_BOUNDARY_RE = /([.!?]+)(\s+)(?=[A-Z0-9"'\[])/g;
const INITIAL_RE = /(?:^|[\s(])[A-Z]\.$/;

function isAbbreviationBoundary(text: string, punctEnd: number): boolean {
  const prefix = text.slice(Math.max(0, punctEnd - 20), punctEnd).trimEnd();
  const lower = prefix.toLowerCase();
  for (const a of ABBREVIATIONS) {
    if (lower.endsWith(a)) return true;
  }
  if (INITIAL_RE.test(prefix)) return true;
  return false;
}

export function splitSentences(text: string): Array<[string, number]> {
  if (!text) return [];
  const splits = [0];
  CANDIDATE_BOUNDARY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CANDIDATE_BOUNDARY_RE.exec(text)) !== null) {
    const punctEnd = m.index + m[1].length;
    if (isAbbreviationBoundary(text, punctEnd)) continue;
    splits.push(m.index + m[0].length);
  }
  splits.push(text.length);
  const out: Array<[string, number]> = [];
  for (let i = 0; i < splits.length - 1; i++) {
    const segment = text.slice(splits[i], splits[i + 1]);
    const stripped = segment.trim();
    if (stripped) out.push([stripped, splits[i] + (segment.length - segment.trimStart().length)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table-row + reference filtering
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(
  "a an the of in on is are was were to for with and or that this which as by from at into be been being it its their his her our your we they he she i you not no can could would should will shall may might than then also such these those but if because while".split(" "),
);

export function isTableLikeLine(line: string, minTokens = 8, threshold = 0.06, maxChars = 3000): boolean {
  if (line.length > maxChars) return false;
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < minTokens) return false;
  const hits = tokens.filter((t) => STOPWORDS.has(t.replace(/[.,;:()[\]]/g, "").toLowerCase())).length;
  return hits / tokens.length < threshold;
}

const REFERENCE_SECTION_RE = /\b(references|bibliography|works\s+cited|citations)\b/i;
const REFERENCE_LINE_START_RE = /^\s*\[\d+\]\s/;

function looksLikeReference(sentence: string, section: string): boolean {
  if (REFERENCE_SECTION_RE.test(section || "")) return true;
  if (REFERENCE_LINE_START_RE.test(sentence)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Chunk-boundary stitching (overlap-aware reassembly)
// ---------------------------------------------------------------------------
const STITCH_MIN_OVERLAP = 20;

function findOverlapLen(a: string, b: string, maxOverlap: number): number {
  maxOverlap = Math.min(maxOverlap, a.length, b.length);
  for (let len = maxOverlap; len >= STITCH_MIN_OVERLAP; len--) {
    if (a.slice(-len) === b.slice(0, len)) return len;
  }
  return 0;
}

export function stitchChunks(
  chunks: PipeChunk[],
  chunkOverlap = 880,
): { text: string; boundaries: Array<{ offset: number; page: number; section: string }> } {
  if (!chunks.length) return { text: "", boundaries: [] };
  const maxSearch = Math.max(chunkOverlap + 300, 300);
  const parts: string[] = [];
  const boundaries: Array<{ offset: number; page: number; section: string }> = [];
  const first = chunks[0];
  parts.push(first.content);
  boundaries.push({ offset: 0, page: first.page ?? 1, section: (first.section || "General Section").trim() });
  let offset = first.content.length;
  let prev = first.content;
  for (const c of chunks.slice(1)) {
    const overlap = findOverlapLen(prev, c.content, maxSearch);
    let fresh = c.content.slice(overlap);
    if (overlap === 0 && parts.length && parts[parts.length - 1] && fresh) {
      const tail = parts[parts.length - 1];
      if (!/\s/.test(tail[tail.length - 1]) && !/\s/.test(fresh[0])) {
        parts.push(" ");
        offset += 1;
      }
    }
    boundaries.push({ offset, page: c.page ?? 1, section: (c.section || "General Section").trim() });
    parts.push(fresh);
    offset += fresh.length;
    prev = c.content;
  }
  return { text: parts.join(""), boundaries };
}

function boundaryForOffset(offset: number, boundaries: Array<{ offset: number; page: number; section: string }>): { page: number; section: string } {
  let idx = 0;
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i].offset <= offset) idx = i;
    else break;
  }
  return { page: boundaries[idx].page, section: boundaries[idx].section };
}

export function detectStaleSections(chunks: PipeChunk[], maxPageSpan = 4): Set<string> {
  const span = new Map<string, [number, number]>();
  for (const c of chunks) {
    const section = (c.section || "").trim();
    if (!section) continue;
    const page = c.page ?? 1;
    const cur = span.get(section);
    span.set(section, cur ? [Math.min(cur[0], page), Math.max(cur[1], page)] : [page, page]);
  }
  return new Set([...span.entries()].filter(([, [lo, hi]]) => hi - lo > maxPageSpan).map(([s]) => s));
}

function formatLabel(page: number, section: string, stale: Set<string>): string {
  return `[LOCATION: Page ${page} | SECTION: ${section}${stale.has(section) ? " (heading may be stale, verify)" : ""}]`;
}

// ---------------------------------------------------------------------------
// Deterministic verbatim-fact extraction (regex layer, no LLM)
// ---------------------------------------------------------------------------
const NUM = String.raw`\d{1,3}(?:,\d{3})*|\d{4,7}`;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTHS_ABBR = "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

const PERCENT_RE = new RegExp(
  String.raw`\b(?:${NUM})(?:\.\d+)?\s?%|\b(?:${NUM})(?:\.\d+)?\s?(?:-|to|and)\s?(?:${NUM})(?:\.\d+)?\s?%|\b(?:${NUM})(?:\.\d+)?\s?percent\b`,
  "i",
);
const DATE_RE = new RegExp(
  String.raw`(?:${MONTHS}|${MONTHS_ABBR})\.?\s+\d{1,2},?\s+\d{4}` +
    String.raw`|\b\d{4}-\d{2}-\d{2}\b` +
    String.raw`|\b\d{1,2}/\d{1,2}/\d{2,4}\b` +
    String.raw`|\b(?:${MONTHS}|${MONTHS_ABBR})\.?\s+\d{4}\b` +
    String.raw`|\bFY\s?\d{2,4}\b` +
    String.raw`|\bQ[1-4]\s?\d{4}\b` +
    String.raw`|\b\d{4}[-–]\d{2,4}\b`,
);
const SAMPLE_TERMS = [
  "participants?", "interviews?", "respondents?", "surveys?", "students?",
  "faculty members?", "responses?", "samples?", "patients?", "subjects?",
  "cases?", "cohorts?", "enrollees?", "specimens?", "trials?", "users?",
  "employees?", "firms?", "companies?", "transactions?", "records?",
  "accounts?", "customers?", "volunteers?", "documents?", "queries?",
  "tokens?", "parameters?", "epochs?", "benchmarks?", "datasets?",
  "articles?", "papers?", "studies?",
];
const SAMPLE_RE = new RegExp(
  String.raw`\b(?:[nN]\s?=\s?(?:${NUM})|(?:${NUM})\s+(?:${SAMPLE_TERMS.join("|")}))\b`,
  "i",
);
const LEGAL_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`pasal\s+\d{1,4}[a-zA-Z]?(?:\s+ayat\s*\(?\d{1,3}(?:\s*,\s*\d{1,3})*\)?)?` +
    String.raw`|uud\s+(?:nri\s+)?(?:tahun\s+)?1945` +
    String.raw`|undang-undang\s+(?:no(?:mor)?\.?\s*)?\d+\s+tahun\s+\d{4}` +
    String.raw`|uu\s+(?:no(?:mor)?\.?\s*)?\d+\s+tahun\s+\d{4}` +
    String.raw`|perppu\s+(?:no(?:mor)?\.?\s*)?\d+\s+tahun\s+\d{4}` +
    String.raw`|peraturan\s+(?:pemerintah|presiden|daerah|desa|menteri)\s+(?:no(?:mor)?\.?\s*)?\d+\s+tahun\s+\d{4}` +
    String.raw`|putusan\s+(?:mahkamah\s+konstitusi|mk|mahkamah\s+agung|ma|pengadilan\s+(?:negeri|tinggi)|pn|pt)\b[^.]{0,80}?no(?:mor)?\.?\s*\d+` +
    String.raw`|no(?:mor)?\.?\s*\d{1,3}/[A-Z]+[-/][A-Z0-9./-]*\d{4}` +
    String.raw`|\b(?:kuhap|kuhperdata|kuh\s?perdata|kuhp|kitab\s+undang-undang\s+hukum\s+(?:pidana|perdata|acara\s+pidana|acara\s+perdata)|hir|rbg|rv)\b` +
    String.raw`)\b`,
  "i",
);
const DATA_SOURCE_KEYWORDS = [
  "Google Forms", "Microsoft Forms", "SurveyMonkey", "Qualtrics", "Zoom",
  "SPSS", "NVivo", "Excel", "Google Sheets", "Stata", "MATLAB", "RStudio",
  "REDCap", "Epic", "PubMed", "MEDLINE", "Cochrane", "ClinicalTrials.gov",
  "Westlaw", "LexisNexis", "PACER",
  "Bloomberg Terminal", "FactSet", "SEC EDGAR", "Capital IQ",
  "GitHub", "Hugging Face", "HuggingFace", "ArXiv", "Kaggle", "ImageNet",
  "Common Crawl", "Wikipedia", "Scopus", "Web of Science", "Google Scholar",
  "JSTOR", "ProQuest", "SSRN", "IEEE Xplore", "ACM Digital Library", "CrossRef",
];
const DATA_SOURCE_RES = DATA_SOURCE_KEYWORDS.map((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));

const VERBATIM_CATEGORIES: Array<[string, RegExp]> = [
  ["Statistics & Percentages", PERCENT_RE],
  ["Dates", DATE_RE],
  ["Sample Sizes", SAMPLE_RE],
  ["Legal Citations (Pasal / UU / Putusan)", LEGAL_RE],
];
const MAX_BULLETS_PER_CATEGORY = 40;
const MAX_SENTENCE_LENGTH = 500;

function dropSubstringDuplicates(items: Array<[string, string]>): Array<[string, string]> {
  const byLen = [...items].sort((a, b) => b[0].length - a[0].length);
  const kept: Array<[string, string]> = [];
  for (const [s, l] of byLen) {
    if (kept.some(([ks]) => ks.includes(s))) continue;
    kept.push([s, l]);
  }
  const keptSet = new Set(kept.map(([s]) => s));
  return items.filter(([s]) => keptSet.has(s));
}

export function extractVerbatimFacts(
  chunks: PipeChunk[],
  stale: Set<string> = new Set(),
): { facts: Record<string, Array<[string, string]>>; tableRowsRemoved: number } {
  const facts: Record<string, Array<[string, string]>> = {};
  for (const [name] of VERBATIM_CATEGORIES) facts[name] = [];
  facts["Data Sources & Tools Referenced"] = [];
  const seen: Record<string, Set<string>> = {};
  for (const name of Object.keys(facts)) seen[name] = new Set();

  const { text: stitched, boundaries } = stitchChunks(chunks);
  // Table-row + page-number cleaning (newline-preserving; browser has no
  // table finder, so rows are dropped, metrics preserved inline).
  let tableRowsRemoved = 0;
  const keptLines: string[] = [];
  for (const line of stitched.split("\n")) {
    const pageNum = line.match(/^\s*(\d{1,4})\s*$/);
    if (pageNum) continue; // standalone page-number artifact
    if (isTableLikeLine(line)) {
      tableRowsRemoved += 1;
      const numbers = line.split(/\s+/).filter((t) => /\d/.test(t));
      if (numbers.length >= 2) keptLines.push(`[Extracted Table Metrics: ${numbers.slice(0, 10).join(" | ")}]`);
      continue;
    }
    keptLines.push(line);
  }
  const cleaned = keptLines.join("\n").replace(/\n/g, " ");

  for (const [sentence, pos] of splitSentences(cleaned)) {
    if (sentence.length > MAX_SENTENCE_LENGTH) continue;
    // Map back to chunk boundary by proportional position (cleaning only
    // removed whole lines, so proportional mapping stays close).
    const frac = cleaned.length ? pos / cleaned.length : 0;
    const approxOffset = Math.floor(frac * stitched.length);
    const { page, section } = boundaryForOffset(approxOffset, boundaries.length ? boundaries : [{ offset: 0, page: 1, section: "General Section" }]);
    if (looksLikeReference(sentence, section)) continue;
    const label = formatLabel(page, section, stale);
    const normalized = sentence.split(/\s+/).join(" ");
    for (const [category, pattern] of VERBATIM_CATEGORIES) {
      pattern.lastIndex = 0;
      if (pattern.test(sentence) && !seen[category].has(normalized)) {
        seen[category].add(normalized);
        facts[category].push([normalized, label]);
      }
    }
    for (const pattern of DATA_SOURCE_RES) {
      pattern.lastIndex = 0;
      if (pattern.test(sentence) && !seen["Data Sources & Tools Referenced"].has(normalized)) {
        seen["Data Sources & Tools Referenced"].add(normalized);
        facts["Data Sources & Tools Referenced"].push([normalized, label]);
        break;
      }
    }
  }
  for (const category of Object.keys(facts)) {
    facts[category] = dropSubstringDuplicates(facts[category]).slice(0, MAX_BULLETS_PER_CATEGORY);
  }
  return { facts, tableRowsRemoved };
}

export function formatVerbatimSection(facts: Record<string, Array<[string, string]>>, tableRowsRemoved: number): string {
  const nonEmpty = Object.entries(facts).filter(([, items]) => items.length > 0);
  if (!nonEmpty.length) return "";
  const lines = [
    "\n### Extracted Data Points (Verbatim)",
    "_The section below is extracted directly from the source text by pattern matching, not generated by the model, so exact figures and dates are guaranteed accurate to the source regardless of any paraphrasing elsewhere in this summary._",
  ];
  for (const [category, items] of nonEmpty) {
    lines.push(`\n**${category}:**`);
    for (const [sentence, label] of items) lines.push(`- ${normalizeLatexSymbols(sentence)} ${label}`);
  }
  if (tableRowsRemoved) {
    lines.push(`\n_Note: ${tableRowsRemoved} table-like row(s) were detected in the source and excluded from the narrative text._`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Budget batching (token-budgeted groups of labeled texts)
// ---------------------------------------------------------------------------
export function batchByBudget(labeled: Array<[string, string]>, budgetTokens: number): Array<Array<[string, string]>> {
  const batches: Array<Array<[string, string]>> = [];
  let current: Array<[string, string]> = [];
  let currentTokens = 0;
  for (let [label, text] of labeled) {
    let item = `${label}\n${text}`;
    let itemTokens = countTokens(item);
    if (itemTokens > budgetTokens) {
      text = text.slice(0, Math.floor(budgetTokens * 3.0)) + "\n[...truncated chunk to fit context budget...]";
      item = `${label}\n${text}`;
      itemTokens = countTokens(item);
    }
    if (current.length && currentTokens + itemTokens > budgetTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push([label, text]);
    currentTokens += itemTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function joinLabeled(labeled: Array<[string, string]>): string {
  return labeled.map(([label, text]) => `${label}\n${text}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Doc-type classification
// ---------------------------------------------------------------------------
export const DOC_TYPES = ["empirical", "survey", "textbook", "theoretical", "legal", "general"] as const;

export function classifyDocTypeToken(response: string): string {
  const lower = response.trim().toLowerCase();
  const firstLine = lower.split("\n")[0]?.trim() ?? lower;
  const token = firstLine.replace(/[^a-z]+/g, "");
  if ((DOC_TYPES as readonly string[]).includes(token)) return token;
  for (const valid of DOC_TYPES) {
    const m = lower.match(new RegExp(`(?<![a-z])${valid}(?![a-z])`));
    if (m && m.index !== undefined) {
      const before = lower.slice(Math.max(0, m.index - 12), m.index);
      if (/(not|non|n't)[\s-]*$/.test(before)) continue;
      return valid;
    }
  }
  return "general";
}

// ---------------------------------------------------------------------------
// System prompts (faithful port of mlra/summarization.py)
// ---------------------------------------------------------------------------
export const DOC_TYPE_SYSTEM_PROMPT =
  "You are an expert academic document classifier. Analyze the provided title, abstract, and introductory text " +
  "and classify the document into EXACTLY ONE of the following categories:\n\n" +
  "1. 'empirical': Original experimental research, user studies, benchmark evaluations, or dataset papers reporting empirical data.\n" +
  "2. 'survey': Literature reviews, systematic surveys, taxonomies, or comparative analyses of existing research.\n" +
  "3. 'textbook': Educational material, textbook chapters, tutorials, or foundational reference materials introducing core concepts.\n" +
  "4. 'theoretical': Mathematical proofs, theoretical computer science, algorithm derivations, or pure conceptual frameworks.\n" +
  "5. 'legal': Case law, statutes, regulations, or legal analyses - including Indonesian court decisions (putusan pengadilan), statutes (UU), and regulations (peraturan).\n" +
  "6. 'general': General articles, technical reports, white papers, or essays.\n\n" +
  "Reply with ONLY the exact category name in lowercase (empirical, survey, textbook, theoretical, legal, or general). Do not explain.";

export const STUFF_SYSTEM_PROMPT =
  "You are a meticulous research assistant. Write a thorough, well-organized summary of the following document.\n\n" +
  "Guidelines:\n" +
  "1. Document Type Adaptation:\n" +
  "   - Empirical Research: Organize around Purpose, Methodology, Key Findings, and Conclusions.\n" +
  "   - Survey/Review Papers: The document surveys OTHER researchers' work. Methods and models described belong to the literature being reviewed, NOT the document's own methodology. Organize by themes/models reviewed.\n" +
  "   - Legal (Indonesian putusan/court decision): Organize around Duduk Perkara (facts, parties, procedural posture), Pokok Perkara (the issues/claims), Dasar Hukum (the governing rules - cite the exact Pasal/ayat and statutes), Pertimbangan Hukum (the court's legal analysis and reasoning), and Amar Putusan (the ruling/holding). Preserve Pasal and ayat citations exactly.\n" +
  "   - Legal (common-law judgment): Organize around Facts, Procedural History, Issue, Rule, Analysis/Application, and Conclusion.\n" +
  "   - General: Organize around main arguments, themes, and conclusions.\n" +
  "2. Rigorous Attribution: keep quotes, stats, and claims strictly attached to the exact speaker/source/entity named.\n" +
  "3. Always include a 'Limitations / Caveats' section if the document discusses limitations, risks, challenges, uncertainties, or future work.\n" +
  "4. Write equations and statistics in plain readable text (e.g. 't(38) = 0.12, p = 0.91') - NEVER use LaTeX delimiters ($ or $$) or [THIS WORK]/[CITED] tags.";

export const MAP_SYSTEM_PROMPT =
  "You are a factual academic extraction assistant analyzing a section of a document.\n\n" +
  "Your task is to extract EVERY important, explicitly supported fact, mathematical formula, " +
  "definition, methodological detail, quantitative result, limitation, caveat, and future-work " +
  "statement from the provided text.\n\n" +
  "CORE PRINCIPLES:\n" +
  "- Be exhaustive but strictly faithful to the source.\n" +
  "- Do not infer, speculate, paraphrase beyond what is necessary for clarity, or add information " +
  "that is not explicitly supported by the text.\n" +
  "- Preserve technical meaning, terminology, mathematical notation, and quantitative details.\n" +
  "- If the text is ambiguous, preserve the ambiguity rather than resolving it through inference.\n\n" +
  "EXTRACTION RULES:\n\n" +
  "1. OUTPUT FORMAT:\n" +
  "- Output ONLY bullet points using the format '- Fact'.\n" +
  "- No introductory prose, headings, summaries, conclusions, or commentary.\n" +
  "- One distinct fact per bullet.\n" +
  "- Do not combine unrelated facts into a single bullet.\n" +
  "- Sub-bullets may be used only when necessary to preserve the structure of a single fact.\n\n" +
  "2. FACTUAL FIDELITY:\n" +
  "- Extract every important fact explicitly stated in the text.\n" +
  "- Keep exact numbers, percentages, dates, sample sizes, measurements, thresholds, " +
  "names, terminology, and other quantitative details.\n" +
  "- Do not round, normalize, reinterpret, or silently correct values.\n" +
  "- Preserve stated causal relationships and correlations exactly as described.\n" +
  "- Do not introduce relationships between entities unless the relationship is explicitly stated.\n\n" +
  "3. ATTRIBUTION & SOURCE OWNERSHIP:\n" +
  "Clearly distinguish the document author's own contributions from cited or previously " +
  "published work.\n" +
  "- Use [THIS WORK] for the author's own proposed method, model, algorithm, experiment, " +
  "proof, analysis, result, finding, contribution, or conclusion.\n" +
  "- Use [CITED] for findings, methods, theories, claims, datasets, algorithms, or conclusions " +
  "attributed to prior literature or other sources.\n" +
  "- If attribution is explicitly stated but ownership cannot be confidently classified, " +
  "preserve the attribution without guessing.\n" +
  "- When useful, identify the cited author, study, or source exactly as stated.\n" +
  "- Skip bare citation/reference lists that contain no attached finding, method, or claim.\n\n" +
  "4. MATHEMATICAL & TECHNICAL EXTRACTION:\n" +
  "- Preserve mathematical equations, formulas, objective functions, constraints, and " +
  "mathematical relationships exactly whenever possible.\n" +
  "- Preserve variable names, subscripts, superscripts, operators, constants, indices, " +
  "conditions, and domains.\n" +
  "- Explicitly extract definitions of variables and parameters when provided.\n" +
  "- Do not simplify, derive, or algebraically transform equations unless the transformation " +
  "is explicitly present in the source.\n\n" +
  "5. METHODOLOGY & ALGORITHMIC RIGOR:\n" +
  "- Extract the methodology, experimental design, procedures, algorithms, architectures, " +
  "pipelines, and implementation details described in the text.\n" +
  "- Preserve exact algorithm names, model names, dataset names, software/tools, versions, " +
  "hyperparameters, training settings, evaluation protocols, and other technical specifications.\n\n" +
  "6. RESULTS & QUANTITATIVE EVIDENCE:\n" +
  "- Extract every reported result that is relevant to the document's claims.\n" +
  "- Preserve exact metrics, scores, percentages, confidence intervals, error rates, " +
  "sample sizes, performance values, and statistical significance values.\n" +
  "- Do not infer statistical significance, practical significance, superiority, or causality " +
  "unless the text explicitly states it.\n\n" +
  "7. DEFINITIONS & CONCEPTS:\n" +
  "- Extract explicit definitions of terms, concepts, variables, models, techniques, " +
  "frameworks, and categories.\n" +
  "- If the document defines a term in a specific or nonstandard way, preserve that definition.\n\n" +
  "8. LIMITATIONS, CAVEATS & FAILURE MODES:\n" +
  "- ALWAYS extract explicitly stated limitations, caveats, assumptions, risks, weaknesses, " +
  "failure modes, edge cases, sources of error, threats to validity, and conditions under " +
  "which a method or finding may not hold.\n" +
  "- Do not omit negative or contradictory findings merely because they are less prominent.\n\n" +
  "9. FUTURE WORK:\n" +
  "- Explicitly extract proposed future work, unresolved problems, recommended improvements, " +
  "open questions, and directions for further research.\n\n" +
  "10. NEGATIVE & NULL FINDINGS:\n" +
  "- Extract statements indicating that an effect was absent, a hypothesis was unsupported, " +
  "a method failed, or an expected result was not observed.\n\n" +
  "11. ENTITY & RELATIONSHIP PRECISION:\n" +
  "- Only state relationships between named entities when explicitly supported by the text.\n" +
  "- Keep entity names exactly as provided whenever practical.\n\n" +
  "12. SOURCE BOUNDARY:\n" +
  "- Extract only information contained in the provided section.\n" +
  "- Do not use outside knowledge to fill gaps or correct the document.\n" +
  "- If a referenced concept is mentioned without explanation, record only what the text states.\n\n" +
  "FINAL QUALITY CHECK: verify you captured all key facts, formulas, methodologies, results, " +
  "[THIS WORK] vs [CITED] attribution, definitions, limitations, negative findings, future work, " +
  "and scope restrictions.\n\n" +
  "Output ONLY the extracted bullet points.";

export const INTERMEDIATE_REDUCE_SYSTEM_PROMPT =
  "You are a factual consolidator. Merge and deduplicate the extracted bullet points below.\n\n" +
  "Rules:\n" +
  "1. Output ONLY bullet points. Do NOT write paragraphs or prose.\n" +
  "2. Keep specific speaker/source names strictly attached to their exact claims - do not fold two different sources' claims into one bullet unless both sides literally said the same thing.\n" +
  "3. Preserve statistics, percentages, sample sizes, dates, and cohort counts exactly as given. Never round, drop, or merge two cohorts' numbers into one.\n" +
  "4. NEVER drop limitations, caveats, risks, or challenges.\n" +
  "5. Drop lower-priority bibliographical notes if space is constrained, but numeric findings and limitations/caveats are never lower-priority.";

const SYNTHESIS_STRUCTURES: Record<string, string> = {
  textbook: "STRUCTURE: Core Concepts -> Architectural Frameworks -> Math & Algorithms -> Applications -> Limitations",
  empirical: "STRUCTURE: Objective -> Proposed Methodology -> Experimental Setup -> Quantitative Results -> Limitations",
  theoretical: "STRUCTURE: Core Problem -> Assumptions & Definitions -> Main Theorems & Proofs -> Complexity -> Open Questions",
  survey: "STRUCTURE: Scope of Survey -> Themes in Literature -> Comparative Analysis -> Research Gaps -> Future Directions",
  legal: "STRUCTURE (Indonesian putusan): Duduk Perkara (Facts & Parties) -> Pokok Perkara (Legal Issues) -> Dasar Hukum (Governing Pasal/UU, cited exactly) -> Pertimbangan Hukum (Court's Legal Analysis) -> Amar Putusan (Holding/Ruling)",
  general: "STRUCTURE: Executive Summary -> Core Arguments -> Key Evidence -> Recommendations -> Limitations",
};

export function synthesisPromptFor(docType: string): string {
  return (
    "You are an expert research assistant writing a rigorous, high-precision academic summary.\n" +
    "FORMATTING & RIGOR RULES:\n" +
    "- Write all equations, statistics, and mathematical notation in plain readable " +
    "text (e.g. 't(38) = 0.12, p = 0.91'). NEVER use LaTeX delimiters ($ or $$) " +
    "or LaTeX commands - a reader must understand every line without a renderer.\n" +
    "- Express attribution in natural language (e.g. 'the authors' own experiment', " +
    "'prior work by X'). NEVER emit [THIS WORK] or [CITED] tags - those are internal " +
    "extraction markers.\n" +
    "- Ensure no section is repeated. Include a dedicated 'Limitations / Caveats' section.\n\n" +
    (SYNTHESIS_STRUCTURES[docType] ?? SYNTHESIS_STRUCTURES.general)
  );
}

// ---------------------------------------------------------------------------
// Output cleanup (port of output_cleanup.py — KaTeX-safe subset)
// ---------------------------------------------------------------------------
const LATEX_ESCAPES: Array<[string, string]> = [
  ["\\$", "$"], ["\\%", "%"], ["\\#", "#"], ["\\&", "&"],
  ["\\{", "{"], ["\\}", "}"], ["\\_", "_"],
];
const LATEX_STRUCTURAL: Array<[RegExp, string]> = [
  [/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2"],
  [/\\sqrt\{([^{}]*)\}/g, "sqrt($1)"],
  [/\\text\{([^{}]*)\}/g, "$1"],
  [/\^\{([^{}]*)\}/g, "^$1"],
  [/_\{([^{}]*)\}/g, "_$1"],
  [/\\quad\b|\\qquad\b/g, " "],
];
const LATEX_SYMBOLS: Array<[string, string]> = [
  ["\\\\leftrightarrow\\b", "↔"], ["\\\\Leftrightarrow\\b", "⇔"],
  ["\\\\rightarrow\\b", "→"], ["\\\\Rightarrow\\b", "⇒"],
  ["\\\\leftarrow\\b", "←"], ["\\\\Leftarrow\\b", "⇐"],
  ["\\\\uparrow\\b", "↑"], ["\\\\downarrow\\b", "↓"],
  ["\\\\to\\b", "→"],
  ["\\\\pm\\b", "±"], ["\\\\mp\\b", "∓"],
  ["\\\\times\\b", "×"], ["\\\\div\\b", "÷"], ["\\\\cdot\\b", "·"],
  ["\\\\ast\\b", "∗"], ["\\\\star\\b", "☆"], ["\\\\circ\\b", "∘"],
  ["\\\\bullet\\b", "•"], ["\\\\oplus\\b", "⊕"], ["\\\\otimes\\b", "⊗"],
  ["\\\\leq\\b", "≤"], ["\\\\le\\b", "≤"],
  ["\\\\geq\\b", "≥"], ["\\\\ge\\b", "≥"],
  ["\\\\neq\\b", "≠"], ["\\\\ne\\b", "≠"],
  ["\\\\approx\\b", "≈"], ["\\\\sim\\b", "∼"],
  ["\\\\simeq\\b", "≃"], ["\\\\cong\\b", "≅"],
  ["\\\\equiv\\b", "≡"], ["\\\\propto\\b", "∝"],
  ["\\\\perp\\b", "⊥"], ["\\\\parallel\\b", "∥"],
  ["\\\\in\\b", "∈"], ["\\\\notin\\b", "∉"],
  ["\\\\subseteq\\b", "⊆"], ["\\\\supseteq\\b", "⊇"],
  ["\\\\subset\\b", "⊂"], ["\\\\supset\\b", "⊃"],
  ["\\\\cup\\b", "∪"], ["\\\\cap\\b", "∩"],
  ["\\\\emptyset\\b", "∅"], ["\\\\forall\\b", "∀"],
  ["\\\\exists\\b", "∃"], ["\\\\neg\\b", "¬"],
  ["\\\\land\\b", "∧"], ["\\\\lor\\b", "∨"],
  ["\\\\infty\\b", "∞"], ["\\\\partial\\b", "∂"],
  ["\\\\nabla\\b", "∇"], ["\\\\sum\\b", "∑"], ["\\\\prod\\b", "∏"],
  ["\\\\int\\b", "∫"], ["\\\\ell\\b", "ℓ"], ["\\\\hbar\\b", "ℏ"],
  ["\\\\ldots\\b", "…"], ["\\\\cdots\\b", "⋯"], ["\\\\dots\\b", "…"],
  ["\\\\alpha\\b", "α"], ["\\\\beta\\b", "β"],
  ["\\\\gamma\\b", "γ"], ["\\\\delta\\b", "δ"],
  ["\\\\epsilon\\b", "ε"], ["\\\\varepsilon\\b", "ε"],
  ["\\\\zeta\\b", "ζ"], ["\\\\eta\\b", "η"],
  ["\\\\theta\\b", "θ"], ["\\\\iota\\b", "ι"],
  ["\\\\kappa\\b", "κ"], ["\\\\lambda\\b", "λ"],
  ["\\\\mu\\b", "μ"], ["\\\\nu\\b", "ν"],
  ["\\\\xi\\b", "ξ"], ["\\\\pi\\b", "π"],
  ["\\\\rho\\b", "ρ"], ["\\\\sigma\\b", "σ"],
  ["\\\\tau\\b", "τ"], ["\\\\phi\\b", "φ"], ["\\\\varphi\\b", "φ"],
  ["\\\\chi\\b", "χ"], ["\\\\psi\\b", "ψ"], ["\\\\omega\\b", "ω"],
  ["\\\\Gamma\\b", "Γ"], ["\\\\Delta\\b", "Δ"],
  ["\\\\Theta\\b", "Θ"], ["\\\\Lambda\\b", "Λ"],
  ["\\\\Xi\\b", "Ξ"], ["\\\\Pi\\b", "Π"],
  ["\\\\Sigma\\b", "Σ"], ["\\\\Phi\\b", "Φ"],
  ["\\\\Psi\\b", "Ψ"], ["\\\\Omega\\b", "Ω"],
];
const LATEX_SYMBOL_RES: Array<[RegExp, string]> = LATEX_SYMBOLS.map(([p, s]) => [new RegExp(p, "g"), s]);

/** LaTeX → readable text. Safe for verbatim excerpts (notation only). */
export function normalizeLatexSymbols(text: string): string {
  if (!text) return text;
  for (const [from, to] of LATEX_ESCAPES) text = text.split(from).join(to);
  for (const [re, to] of LATEX_STRUCTURAL) {
    re.lastIndex = 0;
    text = text.replace(re, to);
  }
  for (const [re, sym] of LATEX_SYMBOL_RES) {
    re.lastIndex = 0;
    text = text.replace(re, sym);
  }
  return text;
}

const INTERNAL_TAG_RE = /\[\s*(?:THIS WORK|CITED)\s*\]/gi;
const LITERAL_NEWLINE_RE = /(?<!\\)\\n/g;

/** Full cleanup for GENERATED text: literal-\n fix + internal tag strip.
 *  Math delimiters are preserved for the KaTeX frontend. */
export function sanitizeModelOutput(text: string): string {
  if (!text) return text;
  text = text.replace(LITERAL_NEWLINE_RE, "\n");
  text = text.replace(INTERNAL_TAG_RE, "");
  text = text.replace(/\s+\./g, ".");
  text = text.replace(/[ ]{2,}/g, " ");
  return text.trim();
}
