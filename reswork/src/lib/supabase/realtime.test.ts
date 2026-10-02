import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = path.join(__dirname, "realtime.ts");

function src(): string {
  return fs.readFileSync(FILE, "utf8");
}

describe("realtime channel (Phase 2 guards)", () => {
  it("publishes collection/tag events for the directory refresh", () => {
    const text = src();
    expect(text).toContain("collection-changed");
    expect(text).toContain("tag-changed");
    // Server-filtered at the source like every other table.
    expect(text).toMatch(/table:\s*"collections",\s*filter:\s*`workspace_id=eq\./);
    expect(text).toMatch(/table:\s*"tags",\s*filter:\s*`workspace_id=eq\./);
  });

  it("keeps chat_imports workspace-scoped in-client (no broadcast revert)", () => {
    // chat_imports has no workspace_id column (see 0001_init.sql), so a
    // server filter is impossible; the relevance lookup must stay.
    const text = src();
    expect(text).toContain("target_chat_id");
    expect(text).toMatch(/workspace_id.*===.*workspaceId|workspaceId.*===.*workspace_id/);
    expect(text).toContain("no workspace_id");
  });

  it("exposes subscribe status so views can reset on reconnect", () => {
    const text = src();
    expect(text).toContain("onStatus");
    expect(text).toMatch(/\.subscribe\(\(status\)/);
  });

  it("uses a unique topic per subscriber (no .on-after-subscribe collision)", () => {
    // supabase-js returns one shared channel per topic: a static
    // `workspace:<id>` topic throws when Sidebar, library and toasts
    // subscribe concurrently. The topic must carry a per-call suffix.
    const text = src();
    expect(text).not.toMatch(/\.channel\(`workspace:\$\{workspaceId\}`\)/);
    expect(text).toMatch(/\.channel\(`workspace:\$\{workspaceId\}:\$\{/);
  });
});
