// Deterministic legal extraction (port of core/legal/extraction.py).
// Regex-based, no LLM: case metadata + cited case/statute/article identifiers.

const COURTS = [
  "Mahkamah Konstitusi", "Mahkamah Agung", "Pengadilan Negeri",
  "Pengadilan Tinggi", "Pengadilan Agama", "Pengadilan Tinggi Agama",
  "PTUN", "Pengadilan Tata Usaha Negara", "Mahkamah Syar'iyah",
  "Pengadilan Militer", "Pengadilan Tindak Pidana Korupsi",
  "Pengadilan Niaga", "Pengadilan Hubungan Industrial",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COURTS_RE = new RegExp(COURTS.slice().sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi");
const CASE_NUMBER_RE = /(?:No(?:mor)?\.?\s*)?(\d{1,4}\s*\/\s*[A-Za-z][A-Za-z0-9.\-/]*?\/\s*\d{4}\s*\/\s*(?:PN|PT|PA|PTA|PTUN|MA|MK)[A-Za-z0-9.\-]*)/i;
const MK_CASE_NUMBER_RE = /(?:No(?:mor)?\.?\s*)?(\d{1,3}\s*\/\s*PUU\s*[-/][A-Z0-9]+\/\s*\d{4})/i;
const CITED_CASE_RE = /(?:(?:putusan|keputusan)\s+)?(?:mahkamah\s+konstitusi|mk|mahkamah\s+agung|ma|pengadilan\s+(?:negeri|tinggi)|pn|pt|pa|ptun)\s+(?:no(?:mor)?\.?\s*)?(\d{1,4}\s*\/\s*[A-Za-z][A-Za-z0-9.\-/]*?\/\s*\d{4}(?:\s*\/\s*(?:PN|PT|PA|PTA|PTUN|MA|MK)[A-Za-z0-9.\-]*)?)/gi;
const CITED_PUU_RE = /(\d{1,3}\s*\/\s*PUU\s*[-/][A-Z0-9]+\/\s*\d{4})/gi;
const STATUTE_RE = /(?:(?:undang-undang|uu|perppu|peraturan\s+pemerintah|pp|perpres|perda)\s+)?(?:no(?:mor)?\.?\s*)?(\d{1,3})\s*\/\s*(\d{4})/i;
const STATUTE_NAME_RE = /(undang-undang|uu|perppu|peraturan\s+pemerintah|pp|perpres|peraturan\s+daerah|perda)/gi;
const ARTICLE_RE = /pasal\s+(\d{1,4}\s?[A-Z]?)\s*(?:ayat\s*\(?(\d{1,3}(?:\s*,\s*\d{1,3})*)\)?)?/gi;
const PARTY_RE = /\b(Para\s+Pemohon|Pemohon|Para\s+Termohon|Termohon|Penggugat|Tergugat|Terbanding|Pembanding|Penuntut\s+Umum|Terdakwa|Pihak\s+Terkait)\b/gi;
const NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/;

export function normalizeCaseNumber(value: string): string {
  let v = (value || "").replace(/\s+/g, "").trim();
  v = v.replace(/^(?:no|nomor)\.?:?/i, "");
  return v.toUpperCase();
}

export interface CaseMetadata {
  court: string | null;
  case_number: string | null;
  parties: string[];
  decision_type: string | null;
  decision_date: string | null;
}

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

export function extractCaseMetadata(text: string): CaseMetadata {
  if (!text) return { court: null, case_number: null, parties: [], decision_type: null, decision_date: null };
  const courts = [...new Set([...text.slice(0, 20000).matchAll(COURTS_RE)].map((m) => m[0]))].sort();
  let caseNumber: string | null = null;
  const m1 = CASE_NUMBER_RE.exec(text);
  const m2 = m1 ? null : MK_CASE_NUMBER_RE.exec(text);
  if (m1) caseNumber = normalizeCaseNumber(m1[1]);
  else if (m2) caseNumber = normalizeCaseNumber(m2[1]);

  const parties: string[] = [];
  PARTY_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  const head = text.slice(0, 30000);
  PARTY_RE.lastIndex = 0;
  while ((pm = PARTY_RE.exec(head)) !== null) {
    const role = pm[1];
    let tail = head.slice(pm.index + pm[0].length, pm.index + pm[0].length + 160).split("\n")[0].replace(/^[ ,.():]+/, "");
    const nm = NAME_RE.exec(tail);
    if (nm) parties.push(`${role}: ${nm[0]}`);
    if (parties.length >= 24) break;
  }
  const uniqueParties = [...new Set(parties)].slice(0, 12);
  const decisionType = /\bputusan\b/i.test(text.slice(0, 5000)) ? "putusan" : null;
  let decisionDate: string | null = null;
  const dm = /(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})/i.exec(head);
  if (dm) {
    const mm = String(MONTHS[dm[2].toLowerCase()] ?? 1).padStart(2, "0");
    decisionDate = `${dm[3]}-${mm}-${String(Number(dm[1])).padStart(2, "0")}`;
  } else {
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text.slice(0, 5000));
    decisionDate = iso ? iso[0] : null;
  }
  return { court: courts[0] ?? null, case_number: caseNumber, parties: uniqueParties, decision_type: decisionType, decision_date: decisionDate };
}

export interface CitedIdentifier {
  kind: "case" | "statute" | "article";
  identifier: string;
  locator: string | null;
}

export function extractCitedIdentifiers(text: string): CitedIdentifier[] {
  if (!text) return [];
  const refs: CitedIdentifier[] = [];
  const seen = new Set<string>();
  const push = (kind: CitedIdentifier["kind"], identifier: string) => {
    const k = `${kind}:${identifier}`;
    if (!seen.has(k)) {
      seen.add(k);
      refs.push({ kind, identifier, locator: null });
    }
  };
  for (const m of text.matchAll(CITED_PUU_RE)) push("case", normalizeCaseNumber(m[1]));
  CITED_CASE_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CITED_CASE_RE.exec(text)) !== null) push("case", normalizeCaseNumber(cm[1]));
  ARTICLE_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ARTICLE_RE.exec(text)) !== null) {
    const ayat = am[2];
    push("article", `PASAL ${am[1].toUpperCase()}` + (ayat ? ` AYAT (${ayat})` : ""));
  }
  STATUTE_NAME_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = STATUTE_NAME_RE.exec(text)) !== null) {
    const window = text.slice(sm.index + sm[0].length, sm.index + sm[0].length + 200);
    let ident: string | null = null;
    const numM = STATUTE_RE.exec(window);
    if (numM) ident = `${sm[1].toUpperCase()} ${numM[1]}/${numM[2]}`;
    else {
      const namedM = /(?:no(?:mor)?\.?\s*)?(\d{1,3})\s+tahun\s+(\d{4})/i.exec(window);
      if (namedM) ident = `${sm[1].toUpperCase()} ${namedM[1]}/${namedM[2]}`;
    }
    if (ident) push("statute", ident);
  }
  return refs;
}
