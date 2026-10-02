import { describe, expect, it } from "vitest";
import { toSel } from "./inference";

// Canonical settings → InferenceSelection mapper (single owner of the
// boundary): defaults come from the stored snapshot, callers override.
describe("toSel", () => {
  it("builds a complete selection from node defaults", () => {
    const sel = toSel();
    expect(sel.provider).toBe("ollama");
    expect(sel.embedMode).toBe("local");
    expect(sel.thinking).toBe(false);
    expect(sel.hybrid).toBe("off");
    expect(sel.mapStage?.provider).toBe("inherit");
  });

  it("lets callers override (extra wins, nothing else moves)", () => {
    const base = toSel();
    const sel = toSel({ thinking: true, broad: true, hybrid: "medium" });
    expect(sel.thinking).toBe(true);
    expect(sel.broad).toBe(true);
    expect(sel.hybrid).toBe("medium");
    expect(sel.provider).toBe(base.provider);
    expect(sel.embedMode).toBe(base.embedMode);
  });
});
