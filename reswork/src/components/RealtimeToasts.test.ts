import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(__dirname, "RealtimeToasts.tsx");

function src(): string {
  return fs.readFileSync(FILE, "utf8");
}

// Regression guard: the 4s auto-dismiss timer must be tracked and cleared on
// unmount / workspace switch. A bare setTimeout with no clearTimeout leaks
// setState calls into unmounted trees and cross-workspace toasts.
describe("RealtimeToasts timer cleanup", () => {
  it("tracks the dismiss timer handle", () => {
    const text = src();
    expect(text).toMatch(/setTimeout\(\(\)\s*=>/);
    expect(text).toContain("timersRef");
  });

  it("clears every pending timer in the effect cleanup", () => {
    const text = src();
    expect(text).toContain("clearTimeout");
    // Cleanup must both unsubscribe AND clear timers (not just `return unsub`).
    expect(text).toMatch(/return\s*\(\)\s*=>\s*\{[\s\S]*?unsub\(\)[\s\S]*?clearTimeout[\s\S]*?\}/);
  });
});
