// Reusable static scanners (Phase 8).
//
// One implementation for every lint/arch guard that reasons about source
// text: file walking plus focused finders (intervals, fetches, numeric
// parsing, select-lists, migration tables). Guard tests assert on the
// structured findings instead of re-implementing scanning each — add a new
// rule by adding a finder here and a describe block in enforcement.test.ts.
// Pure node (fs/path only); never imports application code.

import * as fs from "node:fs";
import * as path from "node:path";

export interface SourceFile {
  /** Repo-root-relative posix path, e.g. src/app/page.tsx. */
  rel: string;
  abs: string;
  text: string;
  lines: string[];
}

export interface ScanOptions {
  /** File extensions to include. Default: TypeScript sources. */
  extensions?: RegExp;
  /** Skip *.test.* files (they assert on guards, not production code). Default true. */
  excludeTests?: boolean;
}

export function listSourceFiles(rootDir: string, opts: ScanOptions = {}): SourceFile[] {
  const extensions = opts.extensions ?? /\.tsx?$/;
  const excludeTests = opts.excludeTests ?? true;
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.test(entry.name)) continue;
      if (excludeTests && /\.test\.tsx?$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      out.push({ rel: path.relative(rootDir, full).replace(/\\/g, "/"), abs: full, text, lines: text.split("\n") });
    }
  };
  walk(rootDir);
  return out;
}

/** src/** production files for a research-workbench checkout. */
export function appSources(repoRoot: string): SourceFile[] {
  return listSourceFiles(path.join(repoRoot, "src"));
}

function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length;
}

// -- setInterval -------------------------------------------------------------

export interface IntervalSite {
  file: string;
  line: number;
  delayToken: string;
  delayMs: number | null;
  annotated: boolean;
}

// Split a timer call's ( CALLBACK , DELAY ) args at the top-level comma
// (depth 1), so commas nested inside the callback cannot be mistaken for
// the delay. (Spelled without the identifier so this module stays clean
// under its own guard.)
function delayTokenAfter(text: string, openParenIdx: number): { token: string; endIdx: number } | null {
  let depth = 1;
  let i = openParenIdx + 1;
  let inStr: string | null = null;
  let lineComment = false;
  let topComma = -1;
  for (; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1 && topComma === -1) {
      topComma = i;
    }
  }
  if (depth !== 0 || topComma === -1) return null;
  const token = text.slice(topComma + 1, i).trim();
  return { token, endIdx: i };
}

/** Every interval-timer site with its delay expression + poll-ok annotation state. */
export function findSetIntervals(files: SourceFile[]): IntervalSite[] {
  const sites: IntervalSite[] = [];
  for (const file of files) {
    const { text } = file;
    let from = 0;
    for (;;) {
      const idx = text.indexOf("setInterval(", from);
      if (idx === -1) break;
      const found = delayTokenAfter(text, idx + "setInterval".length);
      from = idx + 1;
      if (!found) continue;
      const token = found.token.replace(/;$/, "").trim();
      const numeric = /^(\d[\d_]*)$/.exec(token);
      const delayMs = numeric ? Number(numeric[1].replace(/_/g, "")) : null;
      const startLine = lineOf(text, idx);
      const endLine = lineOf(text, found.endIdx);
      const window = file.lines.slice(Math.max(0, startLine - 3), endLine).join("\n");
      sites.push({ file: file.rel, line: startLine, delayToken: token, delayMs, annotated: /poll-ok:/.test(window) });
    }
  }
  return sites;
}

// -- fetch -------------------------------------------------------------------

export interface BareFetchSite {
  file: string;
  line: number;
}

/** Remove comments so prose mentioning fetch( is not flagged. */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      // Naive line-comment strip: safe for the scanner because a truncated
      // URL later on the line can only hide a fetch(, never invent one
      // before the comment start.
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/**
 * Bare fetch( calls (anything that is not fetchWithTimeout(). Callers strip
 * fetchWithTimeout first, hence the plain pattern here.
 */
export function findBareFetches(files: SourceFile[]): BareFetchSite[] {
  const sites: BareFetchSite[] = [];
  for (const file of files) {
    const stripped = stripComments(file.text.replace(/fetchWithTimeout/g, ""));
    let from = 0;
    for (;;) {
      const match = /\bfetch\s*\(/.exec(stripped.slice(from));
      if (!match || match.index === undefined) break;
      const idx = from + match.index;
      sites.push({ file: file.rel, line: lineOf(stripped, idx) });
      from = idx + 1;
    }
  }
  return sites;
}

// -- numeric parsing -----------------------------------------------------------

export interface NumericParseSite {
  file: string;
  line: number;
  text: string;
}

/** Ad-hoc numeric coercions (Number(/parseInt(/parseFloat(). */
export function findNumericParsing(files: SourceFile[]): NumericParseSite[] {
  const sites: NumericParseSite[] = [];
  for (const file of files) {
    file.lines.forEach((line, i) => {
      if (/\b(Number\(|parseInt\(|parseFloat\()/.test(line)) {
        sites.push({ file: file.rel, line: i + 1, text: line.trim() });
      }
    });
  }
  return sites;
}

// -- select lists -----------------------------------------------------------------

export interface SelectStarSite {
  file: string;
  line: number;
  table: string | null;
}

/**
 * select("*") sites with the nearest preceding from("table") (≤400 chars
 * back) for attribution. Table null = no from( nearby (dynamic table).
 */
export function findSelectStars(files: SourceFile[], maxBackChars = 400): SelectStarSite[] {
  const sites: SelectStarSite[] = [];
  for (const file of files) {
    const re = /\.select\(\s*["']\*["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.text)) !== null) {
      const back = file.text.slice(Math.max(0, m.index - maxBackChars), m.index);
      const froms = [...back.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)];
      const table = froms.length ? froms[froms.length - 1][1] : null;
      sites.push({ file: file.rel, line: lineOf(file.text, m.index), table });
    }
  }
  return sites;
}

// -- migrations ----------------------------------------------------------------------

export interface MigrationStructure {
  createdTables: string[];
  rlsTables: string[];
  policyTables: string[];
}

/** Created tables, RLS-enabled tables, and policy-covered tables per SQL file. */
export function parseMigrationSql(sql: string): MigrationStructure {
  const created = new Set<string>();
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)) created.add(m[1]);
  const rls = new Set<string>();
  for (const stmt of sql.split(";")) {
    if (/enable\s+row\s+level\s+security/i.test(stmt)) {
      const m = /public\.(\w+)/.exec(stmt);
      if (m) rls.add(m[1]);
    }
  }
  const policies = new Set<string>();
  for (const m of sql.matchAll(/create\s+policy\s+"[^"]+"\s*\n?\s*on\s+(?:public\.(\w+)|storage\.objects)/gi)) {
    if (m[1]) policies.add(m[1]);
    else policies.add("storage.objects");
  }
  return { createdTables: [...created], rlsTables: [...rls], policyTables: [...policies] };
}

export function parseMigrationsDir(migrationsDir: string): Map<string, MigrationStructure> {
  const out = new Map<string, MigrationStructure>();
  for (const entry of fs.readdirSync(migrationsDir)) {
    if (!/\.sql$/.test(entry)) continue;
    out.set(entry, parseMigrationSql(fs.readFileSync(path.join(migrationsDir, entry), "utf8")));
  }
  return out;
}
