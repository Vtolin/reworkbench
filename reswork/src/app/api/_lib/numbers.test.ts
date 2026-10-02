import { describe, expect, it } from "vitest";
import { parseBoundedInt } from "./numbers";

describe("parseBoundedInt", () => {
  const limit = { min: 1, max: 200, name: "limit", missing: 50, onInvalid: "error" } as const;

  it("defaults when missing, clamps and floors when finite", () => {
    expect(parseBoundedInt(null, limit)).toEqual({ value: 50 });
    expect(parseBoundedInt(undefined, limit)).toEqual({ value: 50 });
    expect(parseBoundedInt("10", limit)).toEqual({ value: 10 });
    expect(parseBoundedInt(1000, limit)).toEqual({ value: 200 });
    expect(parseBoundedInt(0, limit)).toEqual({ value: 1 });
    expect(parseBoundedInt("25.9", limit)).toEqual({ value: 25 });
    // Empty string coerces to 0 → clamped to the minimum, never NaN.
    expect(parseBoundedInt("", limit)).toEqual({ value: 1 });
  });

  it("rejects non-finite input in error mode", () => {
    for (const bad of ["abc", "NaN", "Infinity", "-Infinity", Infinity, Number.NaN]) {
      expect(parseBoundedInt(bad, limit)).toEqual({ error: "limit must be a number" });
    }
  });

  it("falls back in fallback mode (invalid acts as missing)", () => {
    const fallback = { min: 128, max: 16384, name: "maxTokens", missing: undefined, onInvalid: "fallback" } as const;
    expect(parseBoundedInt("abc", fallback)).toEqual({ value: undefined });
    expect(parseBoundedInt(null, fallback)).toEqual({ value: undefined });
    expect(parseBoundedInt(99999, fallback)).toEqual({ value: 16384 });
  });

  it("never yields NaN", () => {
    for (const raw of ["abc", "NaN", "Infinity", null, undefined, "10", 5]) {
      const out = parseBoundedInt(raw, limit);
      if ("value" in out && out.value !== undefined) expect(Number.isFinite(out.value)).toBe(true);
    }
  });
});
