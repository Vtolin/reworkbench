import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { appSources, findSetIntervals } from "./arch/scan";

// Interval guard (Phase 2 acceptance, Phase 8 enforcement): fail on
// setInterval( with a delay under 15000ms unless annotated
// `// poll-ok: <reason>` on the same line or within two lines above the
// interval statement. Non-literal delays (named constants) need the
// annotation too, so the cadence is always documented.
// Rationale: idle tabs must issue ~0 queries/min; sub-15s timers are only
// acceptable when they provably cost zero I/O (local clocks) or are the
// mandated slow fallback. Scanning lives in arch/scan (reusable).

const MIN_INTERVAL_MS = 15_000;
const sites = findSetIntervals(appSources(path.join(__dirname, "..")));

describe("polling guard", () => {
  it("fails on sub-15s setInterval without a poll-ok reason", () => {
    const bad = sites.filter(
      (s) => (s.delayMs !== null && s.delayMs < MIN_INTERVAL_MS && !s.annotated) || (s.delayMs === null && !s.annotated),
    );
    expect(bad.map((s) => `${s.file}:${s.line} delay=${s.delayToken}`)).toEqual([]);
  });

  it("keeps directory views realtime-driven (no timers in Sidebar/library)", () => {
    const inDir = (f: string): boolean => f === "src/components/Sidebar.tsx" || f === "src/app/page.tsx";
    expect(sites.filter((s) => inDir(s.file)).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("documents the remaining annotated cadences (non-vacuous)", () => {
    const annotated = sites.filter((s) => s.annotated);
    // fallbackPoll (60s realtime fallback) + research elapsed clock.
    expect(annotated.length).toBeGreaterThanOrEqual(2);
    expect(annotated.map((s) => s.file).join(",")).toContain("fallbackPoll.ts");
  });
});
