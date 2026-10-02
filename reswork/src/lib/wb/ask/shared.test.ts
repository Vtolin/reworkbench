import { describe, expect, it } from "vitest";
import { extractJsonArray } from "./shared";

// Canonical live copy (Phase 9): the byte-identical duplicate in
// lib/research/analysis.ts was dead code and has been removed.
describe("extractJsonArray", () => {
  it("parses a fenced JSON array", () => {
    expect(extractJsonArray<string>('```json\n["a", "b"]\n```')).toEqual(["a", "b"]);
  });

  it("parses a bare JSON array", () => {
    expect(extractJsonArray<number>('[{"x": 1}]')).toEqual([{ x: 1 }]);
  });

  it("throws when no array exists", () => {
    expect(() => extractJsonArray("no json here")).toThrow("No JSON array in model output");
  });
});
