// Architectural boundary enforcement (Phase 16).
//
// Static import scanner: locks the dependency rules the remediation
// established, so regressions fail `npm test` instead of rotting silently.
// - lib/** must not reach UI at runtime (app/components/contexts/react);
//   type-only context imports (e.g. publish.ts) are allowed.
// - API routes must use the server Supabase client, never the browser one.
// - Pages/components/contexts must never reach server-only modules
//   (service-role client, BYOK key crypto).
// - `as any` must not spread: per-file caps pin the legacy inventory;
//   any file not listed has a cap of zero.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.join(__dirname);

function sourceFiles(under: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(SRC, under));
  return out;
}

// All static + dynamic import specifiers in a file (type-only imports
// flagged separately so callers can allow them).
function importsOf(file: string): Array<{ spec: string; typeOnly: boolean }> {
  const text = fs.readFileSync(file, "utf8");
  const found: Array<{ spec: string; typeOnly: boolean }> = [];
  const staticRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(text)) !== null) {
    const leadingType = m[1] !== undefined;
    const clause = m[2].trim();
    const inlineOnlyTypes =
      /^\{[^}]*\}$/.test(clause) &&
      clause
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith("type "));
    found.push({ spec: m[3], typeOnly: leadingType || inlineOnlyTypes });
  }
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynRe.exec(text)) !== null) found.push({ spec: m[1], typeOnly: false });
  return found;
}

const rel = (f: string): string => path.relative(SRC, f).replace(/\\/g, "/");

describe("dependency boundaries", () => {
  it("scanner covers the codebase (non-vacuous)", () => {
    const all = [
      ...sourceFiles("lib"),
      ...sourceFiles("app"),
      ...sourceFiles("components"),
      ...sourceFiles("contexts"),
    ];
    expect(all.length).toBeGreaterThan(60);
    expect(sourceFiles("lib").length).toBeGreaterThan(30);
  });
  it("lib/** has no runtime imports from UI layers or React", () => {
    const bad: string[] = [];
    for (const f of sourceFiles("lib")) {
      for (const imp of importsOf(f)) {
        if (imp.typeOnly) continue;
        if (/^@\/(app|components|contexts)\//.test(imp.spec) || imp.spec === "react") {
          bad.push(`${rel(f)} -> ${imp.spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("API routes never use the browser Supabase client", () => {
    const bad: string[] = [];
    for (const f of sourceFiles("app/api")) {
      for (const imp of importsOf(f)) {
        if (imp.spec === "@/lib/supabase/client") bad.push(rel(f));
      }
    }
    expect(bad).toEqual([]);
  });

  it("browser code never reaches server-only modules", () => {
    const bad: string[] = [];
    const areas = ["app", "components", "contexts"].flatMap((a) =>
      sourceFiles(a).filter((f) => !rel(f).startsWith("app/api/")),
    );
    for (const f of areas) {
      for (const imp of importsOf(f)) {
        if (imp.spec === "@/lib/supabase/server" || imp.spec === "@/lib/ai/keys") {
          bad.push(`${rel(f)} -> ${imp.spec}`);
        }
      }
    }
    // Service-role construction must only appear in server routes/lib.
    for (const f of areas) {
      const text = fs.readFileSync(f, "utf8");
      if (/createServiceSupabase\s*\(/.test(text)) bad.push(`${rel(f)} calls createServiceSupabase`);
    }
    expect(bad).toEqual([]);
  });
});

describe("as-any ratchet", () => {
  // Legacy inventory (grep-verified): totals must not grow, and no new
  // file may introduce one. Per-file caps tolerate line shifts.
  const CAPS: Record<string, number> = {
    "app/research/page.tsx": 2,
    "app/settings/page.tsx": 6,
    // Phase 6: DocDetail (was 1) and UploadFlow (was 5) are as-any-free;
    // the ratchet only goes down — no entry means zero tolerance.
  };

  it("no new as-any appears outside the legacy inventory", () => {
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        const count = (text.match(/as any\b/g) ?? []).length;
        const key = path.relative(SRC, full).replace(/\\/g, "/");
        // Scope: application sources only (supabase/ excluded by walk root).
        const cap = CAPS[key] ?? 0;
        if (count > cap) violations.push(`${key}: ${count} > cap ${cap}`);
      }
    };
    walk(SRC);
    expect(violations).toEqual([]);
  });
});
