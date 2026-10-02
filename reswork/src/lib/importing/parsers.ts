// Reference import/export parsers (port of core/importing/parsers.py).
// BibTeX / BibLaTeX, RIS, EndNote XML, CSL-JSON. Tolerant: malformed entries
// are skipped, never fatal. Serializers live in lib/citations/csl.ts.

export interface ImportRecord {
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
  rawKey: string | null;
  collections: string[];
  file?: string | null;
}

// ------------------------------------------------------------------ BibTeX
const ENTRY_RE = /@(\w+)\s*[{(\s]*([^,\s]*)\s*,/gi;
const FIELD_RE = /([a-zA-Z][\w:.-]*)\s*=\s*(?:\{([^{}]*)\}|"([^"]*)"|([^,}\s]+))\s*,?/y;

function stripBraces(value: string): string {
  let v = value.trim();
  const balanced = (s: string) => {
    let d = 0;
    for (const ch of s) {
      if (ch === "{") d++;
      else if (ch === "}") {
        d--;
        if (d < 0) return false;
      }
    }
    return d === 0;
  };
  while (v.startsWith("{") && v.endsWith("}") && balanced(v)) v = v.slice(1, -1).trim();
  v = v.replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\_/g, "_").replace(/\\#/g, "#").replace(/[{}]/g, "");
  return v.split(/\s+/).join(" ");
}

function extractBalanced(text: string, start: number): { inner: string; next: number } {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { inner: text.slice(start + 1, i), next: i + 1 };
    }
    i++;
  }
  return { inner: text.slice(start + 1), next: text.length };
}

function bibtexFieldsToRecord(fields: Record<string, string>, key: string): ImportRecord {
  const authors = (fields.author ?? "")
    .split(/\s+and\s+/i)
    .map((n) => n.trim())
    .filter(Boolean);
  const yearM = String(fields.year ?? "").match(/\d{4}/);
  let pages = fields.pages ?? "";
  if (pages.includes("--")) pages = pages.replace(/--/g, "-");
  const journal = fields.journal ?? fields.journaltitle ?? fields.booktitle ?? null;
  const collections: string[] = [];
  for (const f of ["groups", "collection", "collections"]) {
    if (fields[f]) collections.push(...fields[f].split(/[;,]/).map((c) => c.trim()).filter(Boolean));
  }
  const keywords = fields.keywords ?? fields.keyword ?? "";
  if (keywords) collections.push(...keywords.split(/[;,]/).map((c) => c.trim()).filter(Boolean));
  return {
    title: fields.title || null,
    authors,
    year: yearM ? Number(yearM[0]) : null,
    doi: fields.doi || null,
    journal,
    volume: fields.volume || null,
    issue: fields.number ?? fields.issue ?? null,
    pages: pages || null,
    publisher: fields.publisher || null,
    abstract: fields.abstract || null,
    rawKey: key || null,
    collections: [...new Set(collections)].slice(0, 5),
    file: fields.file || null,
  };
}

export function parseBibtex(text: string): ImportRecord[] {
  const entries: ImportRecord[] = [];
  ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY_RE.exec(text)) !== null) {
    const key = m[2].trim();
    const bodyStart = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const body = text.slice(bodyStart, end);
    const fields: Record<string, string> = {};
    let fpos = 0;
    while (fpos < body.length) {
      FIELD_RE.lastIndex = fpos;
      const fm = FIELD_RE.exec(body);
      if (fm && fm.index === fpos) {
        const val = fm[2] ?? fm[3] ?? fm[4] ?? "";
        fields[fm[1].toLowerCase()] = stripBraces(val);
        fpos = FIELD_RE.lastIndex;
        continue;
      }
      const rest = body.slice(fpos);
      const nm = rest.match(/^\s*([a-zA-Z][\w:.-]*)\s*=\s*\{/);
      if (nm && nm.index === 0) {
        const braceAt = fpos + nm[0].length - 1;
        const { inner, next } = extractBalanced(body, braceAt);
        fields[nm[1].toLowerCase()] = stripBraces(inner);
        fpos = next;
        // skip optional trailing comma
        if (body[fpos] === ",") fpos++;
        continue;
      }
      fpos++;
    }
    if (!Object.keys(fields).length) {
      ENTRY_RE.lastIndex = end + 1;
      continue;
    }
    const entry = bibtexFieldsToRecord(fields, key);
    if (entry.title || entry.authors.length) entries.push(entry);
    ENTRY_RE.lastIndex = end + 1;
  }
  return entries;
}

// --------------------------------------------------------------------- RIS
const RIS_KEYS: Record<string, string> = {
  TY: "type", AU: "author", TI: "title", T1: "title", PY: "year",
  JO: "journal", JF: "journal", T2: "journal", VL: "volume",
  IS: "issue", SP: "pages", EP: "pages_end", PB: "publisher",
  DO: "doi", AB: "abstract", N1: "note",
};
void RIS_KEYS;

export function parseRis(text: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  let current: Record<string, string[]> = {};
  const flush = () => {
    const r = risToRecord(current);
    if (r && (r.title || r.authors.length)) records.push(r);
    current = {};
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("TY  - ") && Object.keys(current).length) flush();
    if (line.includes("  - ")) {
      const idx = line.indexOf("  - ");
      const tag = line.slice(0, idx).trim().toUpperCase();
      current[tag] = current[tag] ?? [];
      current[tag].push(line.slice(idx + 4).trim());
    } else if (line.startsWith("ER")) {
      flush();
    }
  }
  if (Object.keys(current).length) flush();
  return records;
}

function risToRecord(fields: Record<string, string[]>): ImportRecord | null {
  if (!Object.keys(fields).length) return null;
  const first = (k: string) => (fields[k] ?? [])[0] ?? null;
  const authors = fields.AU ?? [];
  const pyM = first("PY") ? String(first("PY")).match(/\d{4}/) : null;
  let pages = first("SP");
  const ep = first("EP");
  if (pages && ep) pages = `${pages}-${ep}`;
  const collections: string[] = [];
  for (const kw of fields.KW ?? []) {
    if (kw.trim()) collections.push(...kw.split(/[;,]/).map((c) => c.trim()).filter(Boolean));
  }
  const db = first("DB");
  if (db && db.trim() && !collections.includes(db.trim())) collections.push(db.trim());
  return {
    title: first("TI") ?? first("T1"),
    authors,
    year: pyM ? Number(pyM[0]) : null,
    doi: first("DO"),
    journal: first("JO") ?? first("JF") ?? first("T2"),
    volume: first("VL"),
    issue: first("IS"),
    pages,
    publisher: first("PB"),
    abstract: first("AB"),
    rawKey: null,
    collections: [...new Set(collections)].slice(0, 5),
    file: first("L1") ?? first("UR") ?? null,
  };
}

// ------------------------------------------------------------ EndNote XML
export function parseEndnoteXml(text: string): ImportRecord[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) return [];
  } catch {
    return [];
  }
  const records: ImportRecord[] = [];
  const txt = (el: Element, sel: string): string | null => {
    // support "a/b" paths minimally
    const parts = sel.split("/");
    let node: Element | null = el;
    for (const p of parts) node = node?.querySelector(`:scope > ${p}`) ?? null;
    const v = node?.textContent?.trim();
    return v || null;
  };
  doc.querySelectorAll("record").forEach((rec) => {
    const authors: string[] = [];
    rec.querySelectorAll("authors > author").forEach((a) => {
      const t = a.textContent?.trim();
      if (t) authors.push(t);
    });
    const yearSrc = txt(rec, "year") ?? txt(rec, "pub-dates > year");
    const yearM = yearSrc ? yearSrc.match(/\d{4}/) : null;
    const collections: string[] = [];
    for (const sel of ["group", "collection", "keywords"]) {
      const v = txt(rec, sel);
      if (v) collections.push(...v.split(/[;,]/).map((c) => c.trim()).filter(Boolean));
    }
    const r: ImportRecord = {
      title: txt(rec, "title"),
      authors,
      year: yearM ? Number(yearM[0]) : null,
      doi: txt(rec, "electronic-resource-num") ?? txt(rec, "doi"),
      journal: txt(rec, "periodical > full-title") ?? txt(rec, "journal"),
      volume: txt(rec, "volume"),
      issue: txt(rec, "number") ?? txt(rec, "issue"),
      pages: txt(rec, "pages"),
      publisher: txt(rec, "publisher"),
      abstract: txt(rec, "abstract"),
      rawKey: txt(rec, "rec-number") ?? txt(rec, "accession-num"),
      collections: [...new Set(collections)].slice(0, 5),
      file: null,
    };
    if (r.title || r.authors.length) records.push(r);
  });
  return records;
}

// ---------------------------------------------------------------- CSL-JSON
export function parseCslJson(text: string): ImportRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(data) ? data : [data];
  const records: ImportRecord[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    const authors = ((item.author as Array<{ given?: string; family?: string }>) ?? [])
      .map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
      .filter(Boolean);
    let year: number | null = null;
    const dp = ((item.issued as { "date-parts"?: unknown[][] } | undefined)?.["date-parts"] ?? [[null]])[0]?.[0];
    if (dp != null && dp !== "") {
      const n = Number(dp);
      if (Number.isFinite(n)) year = n;
    }
    const collVal = (item["collection-title"] ?? item.collection) as string | undefined;
    records.push({
      title: (item.title as string) ?? null,
      authors,
      year,
      doi: (item.DOI as string) ?? null,
      journal: (item["container-title"] as string) ?? null,
      volume: (item.volume as string) ?? null,
      issue: (item.issue as string) ?? null,
      pages: (item.page as string) ?? null,
      publisher: (item.publisher as string) ?? null,
      abstract: (item.abstract as string) ?? null,
      rawKey: String(item.id ?? ""),
      collections: collVal ? [...new Set(collVal.split(/[;,]/).map((c) => c.trim()).filter(Boolean))].slice(0, 5) : [],
      file: (item.URL as string) ?? null,
    });
  }
  return records;
}

export function detectFormat(text: string): string {
  const stripped = (text || "").trimStart();
  if (!stripped) return "unknown";
  if (stripped.startsWith("{") || stripped.startsWith("[")) return "csl-json";
  if (stripped.startsWith("<")) return "endnote-xml";
  if (/^@\w+\s*[{]/m.test(stripped)) return "bibtex";
  if (/^TY\s+-\s+/m.test(stripped)) return "ris";
  return "unknown";
}

export function parseReferences(text: string, fmt?: string): ImportRecord[] {
  const f = (fmt || detectFormat(text)).toLowerCase();
  if (f === "bibtex" || f === "biblatex") return parseBibtex(text);
  if (f === "ris") return parseRis(text);
  if (f === "endnote-xml") return parseEndnoteXml(text);
  if (f === "csl-json") return parseCslJson(text);
  for (const p of [parseBibtex, parseRis, parseCslJson, parseEndnoteXml]) {
    const r = p(text);
    if (r.length) return r;
  }
  return [];
}
