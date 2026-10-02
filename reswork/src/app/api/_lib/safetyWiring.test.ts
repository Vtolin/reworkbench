import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Phase 3 wiring guard: every mandated route must enforce its rate budget,
// and both byte caps must be wired. Catches silent removal of a gate.
const API = path.join(__dirname, "..");

function src(rel: string): string {
  return fs.readFileSync(path.join(API, rel), "utf8");
}

describe("rate-limit wiring", () => {
  const routes: Array<[string, string]> = [
    ["auth/register-admin/route.ts", '"register-admin"'],
    ["ai/proxy/route.ts", '"ai-proxy"'],
    ["rag/embed/route.ts", '"rag-embed"'],
    ["rag/search/route.ts", '"rag-search"'],
    ["research/trail/route.ts", '"research-trail"'],
  ];

  it("gates every mandated route through enforceRateLimit with its scope", () => {
    for (const [rel, scope] of routes) {
      const text = src(rel);
      expect(text).toContain("enforceRateLimit");
      expect(text).toContain(`enforceRateLimit(req, ${scope}`);
    }
  });

  it("keys register-admin by IP (anonymous key-guessing protection)", () => {
    expect(src("auth/register-admin/route.ts")).toContain("perIp: true");
  });
});

describe("request-id wiring (Phase 7)", () => {
  const routes = [
    "auth/register-admin/route.ts",
    "ai/proxy/route.ts",
    "ai/proxy/models/route.ts",
    "rag/embed/route.ts",
    "rag/search/route.ts",
    "research/trail/route.ts",
    "workspaces/members/route.ts",
  ];

  it("threads a correlation id through every audited route", () => {
    for (const rel of routes) {
      const text = src(rel);
      expect(text).toContain("getRequestId");
      expect(text).toMatch(/requestId/);
    }
  });

  it("never logs raw error text alongside the id (category only)", () => {
    for (const rel of routes) {
      const text = src(rel);
      for (const line of text.split("\n")) {
        if (line.includes("logEvent(") || line.includes("logRequest(")) {
          expect(line).not.toMatch(/error\.message/);
        }
      }
    }
  });
});

describe("billed calls are never retried (Phase 7)", () => {
  it("keeps withRetry out of the billed proxy/embed routes", () => {
    for (const rel of ["ai/proxy/route.ts", "rag/embed/route.ts"]) {
      const text = src(rel);
      expect(text).not.toContain("withRetry");
    }
  });
});

describe("size-cap wiring", () => {
  it("caps trail payloads at 32KB with 413", () => {
    const text = src("research/trail/route.ts");
    expect(text).toContain("TRAIL_PAYLOAD_MAX_BYTES");
    expect(text).toContain("tooLargeResponse");
  });

  it("caps proxy messages at 256KB with 413", () => {
    const text = src("ai/proxy/route.ts");
    expect(text).toContain("PROXY_MESSAGES_MAX_BYTES");
    expect(text).toContain("tooLargeResponse");
  });

  it("caps documents-bucket uploads in storage policy", () => {
    const sql = fs.readFileSync(
      path.join(API, "..", "..", "..", "supabase", "migrations", "0012_storage_size_cap.sql"),
      "utf8",
    );
    expect(sql).toContain("documents_bucket_insert_members");
    expect(sql).toContain("52428800");
  });
});
