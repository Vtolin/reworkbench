import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { escapeLike } from "./like";

describe("escapeLike", () => {
  it("leaves plain text untouched", () => {
    expect(escapeLike("hello world")).toBe("hello world");
    expect(escapeLike("")).toBe("");
  });

  it("escapes %, _, and backslash", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("100%_match\\")).toBe("100\\%\\_match\\\\");
  });

  it("round-trips through a contains-pattern without widening", () => {
    const user = "50%_off\\sale";
    const pattern = `%${escapeLike(user)}%`;
    // Every wildcard char the user typed is now backslash-escaped.
    expect(pattern).toBe("%50\\%\\_off\\\\sale%");
  });
});

describe("ilike interpolation sites (static guard)", () => {
  it("routes library.ts interpolations through escapeLike", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "wb", "library.ts"), "utf8");
    expect(src).toContain("%${escapeLike(");
    for (const line of src.split("\n")) {
      if (line.includes(".ilike(")) {
        expect(line).toContain("escapeLike");
      }
    }
  });

  it("routes search.ts interpolations through escapeLike or the shared resolver", () => {
    // Phase 5 factored name resolution into resolveDocLinkIds (docFilters),
    // which escapes internally (pinned by docFilters.test.ts). Raw
    // interpolations must still escape inline; resolver-driven .ilike calls
    // take the pre-escaped `pattern`.
    const src = fs.readFileSync(path.join(__dirname, "..", "wb", "search.ts"), "utf8");
    expect(src).toContain("resolveDocLinkIds");
    for (const line of src.split("\n")) {
      if (line.includes(".ilike(")) {
        expect(line.includes("escapeLike") || line.includes("pattern")).toBe(true);
      }
    }
    // No raw `%${...}%` user interpolation may remain (escaped ones do).
    expect(src).not.toMatch(/\.ilike\("name", `%\$\{(?!escapeLike)/);
  });
});
