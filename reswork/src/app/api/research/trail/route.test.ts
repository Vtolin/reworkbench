import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseTrailLimit } from "./route";

describe("parseTrailLimit", () => {
  it("defaults to 50 when absent", () => {
    expect(parseTrailLimit(null)).toEqual({ limit: 50 });
  });

  it("rejects non-numeric input (NaN) instead of propagating it", () => {
    expect(parseTrailLimit("abc")).toEqual({ error: "limit must be a number" });
    expect(parseTrailLimit("")).not.toEqual({ error: "limit must be a number" });
    // Empty string coerces to 0 -> clamped to the minimum, never NaN.
    expect(parseTrailLimit("")).toEqual({ limit: 1 });
  });

  it("rejects Infinity as invalid", () => {
    expect(parseTrailLimit("Infinity")).toEqual({ error: "limit must be a number" });
  });

  it("clamps finite values to 1..200", () => {
    expect(parseTrailLimit("10")).toEqual({ limit: 10 });
    expect(parseTrailLimit("1000")).toEqual({ limit: 200 });
    expect(parseTrailLimit("0")).toEqual({ limit: 1 });
    expect(parseTrailLimit("-5")).toEqual({ limit: 1 });
    expect(parseTrailLimit("25.9")).toEqual({ limit: 25 });
  });

  it("never yields NaN into the query layer", () => {
    for (const raw of ["abc", "NaN", "Infinity", "-Infinity", "10", null]) {
      const out = parseTrailLimit(raw);
      if ("limit" in out) expect(Number.isFinite(out.limit)).toBe(true);
    }
  });
});

describe("trail GET invalid-limit status (static guard)", () => {
  it("returns 400 for invalid input, not a masked 403", () => {
    const src = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
    // Finite parsing lives in the shared helper (Phase 8); this route must
    // delegate to it (parseTrailLimit wraps parseBoundedInt).
    expect(src).toContain("parseBoundedInt");
    // The invalid-limit branch must answer 400; DB/membership failures keep
    // their existing 403 mapping (unchanged behavior, pinned here).
    expect(src).toMatch(/parsedLimit[\s\S]*?status:\s*400/);
  });
});
