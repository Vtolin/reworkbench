import { describe, expect, it } from "vitest";
import { clampMemberLimit } from "@/lib/permissions/constants";
import { parseFilters } from "@/lib/wb/search";

describe("parseFilters", () => {
  it("extracts structured filters leaving the free-text remainder", () => {
    const filters = parseFilters('author:"John Doe" year:2024 tag:#ml collection:"My Papers" quantum');
    expect(filters.author).toBe("John Doe");
    expect(filters.year).toBe(2024);
    expect(filters.tag).toBe("ml");
    expect(filters.collection).toBe("My Papers");
    expect(filters.text).toBe("quantum");
  });
});

describe("clampMemberLimit", () => {
  it("bounds membership limits to 1..MAX with a safe fallback", () => {
    expect(clampMemberLimit(0)).toBe(1);
    expect(clampMemberLimit(99)).toBe(10);
    expect(clampMemberLimit("7")).toBe(7);
    expect(clampMemberLimit(Number.NaN)).toBe(10);
    expect(clampMemberLimit(undefined)).toBe(10);
  });
});
