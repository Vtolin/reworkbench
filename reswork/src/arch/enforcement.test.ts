import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appSources,
  findBareFetches,
  findNumericParsing,
  findSelectStars,
  listSourceFiles,
  parseMigrationsDir,
} from "./scan";

// Enforcement (Phase 8): the audit findings, pinned as guards so regressions
// fail `npm test`. All scanning lives in ./scan (reusable) — this file only
// states the rules.

const REPO = path.join(__dirname, "..", "..");
const sources = appSources(REPO);
const apiSources = listSourceFiles(path.join(REPO, "src", "app", "api"));

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("no bare fetch in API routes", () => {
  it("forces fetchWithTimeout (explicit deadline) in src/app/api/**", () => {
    const bad = findBareFetches(apiSources);
    expect(bad.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});

describe("finite numeric parsing", () => {
  it("confines ad-hoc coercion to _lib (routes use parseBoundedInt)", () => {
    // apiSources rels are relative to src/app/api — helpers live in _lib/.
    const sites = findNumericParsing(apiSources).filter((s) => !s.file.startsWith("_lib/"));
    expect(sites.map((s) => `${s.file}:${s.line}: ${s.text}`)).toEqual([]);
  });

  it("routes limit params through the shared helper", () => {
    expect(readSrc("src/app/api/rag/search/route.ts")).toContain("parseBoundedInt");
    expect(readSrc("src/app/api/ai/proxy/route.ts")).toContain("parseBoundedInt");
    const trail = readSrc("src/app/api/research/trail/route.ts");
    expect(trail.includes("parseBoundedInt") || trail.includes("parseTrailLimit")).toBe(true);
  });
});

describe("no select-star on wide tables", () => {
  it("bans select('*') on documents and chat_messages repo-wide", () => {
    const bad = findSelectStars(sources).filter((s) => s.table === "documents" || s.table === "chat_messages");
    expect(bad.map((s) => `${s.file}:${s.line} from(${s.table})`)).toEqual([]);
  });
});

describe("migration RLS", () => {
  // Deliberately deny-all (RLS enabled, zero policies): the table is only
  // reachable via service role / SECURITY DEFINER RPCs. Any addition here
  // needs a comment justifying why no policy exists.
  const DENY_ALL: string[] = ["rate_limit_buckets"];

  it("enables RLS on every table created by migrations", () => {
    const byFile = parseMigrationsDir(path.join(REPO, "supabase", "migrations"));
    const created = new Set<string>();
    const rls = new Set<string>();
    for (const struct of byFile.values()) {
      for (const t of struct.createdTables) created.add(t);
      for (const t of struct.rlsTables) rls.add(t);
    }
    expect(created.size).toBeGreaterThan(10); // non-vacuous: the full schema
    const missing = [...created].filter((t) => !rls.has(t));
    expect(missing).toEqual([]);
  });

  it("leaves no table without a policy except documented deny-all", () => {
    const byFile = parseMigrationsDir(path.join(REPO, "supabase", "migrations"));
    const created = new Set<string>();
    const covered = new Set<string>();
    for (const struct of byFile.values()) {
      for (const t of struct.createdTables) created.add(t);
      for (const t of struct.policyTables) covered.add(t);
    }
    covered.add("storage.objects"); // bucket policies live on storage.objects
    const missing = [...created].filter((t) => !covered.has(t) && !DENY_ALL.includes(t));
    expect(missing).toEqual([]);
  });
});
