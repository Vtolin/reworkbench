import { describe, expect, it, vi } from "vitest";
import {
  enforceRateLimit,
  getClientIp,
  rateLimitSubject,
  resolveRateLimit,
  tooManyResponse,
} from "./rateLimit";

describe("resolveRateLimit", () => {
  it("returns sane defaults per scope", () => {
    expect(resolveRateLimit("register-admin")).toEqual({ max: 5, windowSecs: 3600 });
    expect(resolveRateLimit("ai-proxy")).toEqual({ max: 60, windowSecs: 60 });
    expect(resolveRateLimit("rag-embed")).toEqual({ max: 120, windowSecs: 60 });
    expect(resolveRateLimit("rag-search")).toEqual({ max: 120, windowSecs: 60 });
    expect(resolveRateLimit("research-trail")).toEqual({ max: 200, windowSecs: 60 });
  });

  it("honors env overrides, ignores garbage", () => {
    process.env.RATE_LIMIT_AI_PROXY_MAX = "7";
    process.env.RATE_LIMIT_AI_PROXY_WINDOW_SECS = "30";
    try {
      expect(resolveRateLimit("ai-proxy")).toEqual({ max: 7, windowSecs: 30 });
    } finally {
      delete process.env.RATE_LIMIT_AI_PROXY_MAX;
      delete process.env.RATE_LIMIT_AI_PROXY_WINDOW_SECS;
    }
    process.env.RATE_LIMIT_AI_PROXY_MAX = "banana";
    try {
      expect(resolveRateLimit("ai-proxy").max).toBe(60);
    } finally {
      delete process.env.RATE_LIMIT_AI_PROXY_MAX;
    }
  });
});

describe("getClientIp", () => {
  it("takes the first forwarded address", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip, then null", () => {
    expect(getClientIp(new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(getClientIp(new Request("http://x/"))).toBeNull();
  });
});

describe("rateLimitSubject", () => {
  it("keys authenticated scopes by user, anonymous by ip", () => {
    expect(rateLimitSubject({ userId: "u1", ip: "1.1.1.1", perIp: false })).toBe("user:u1");
    expect(rateLimitSubject({ userId: "u1", ip: "1.1.1.1", perIp: true })).toBe("ip:1.1.1.1");
    expect(rateLimitSubject({ userId: null, ip: null, perIp: true })).toBe("ip:unknown");
  });
});

describe("tooManyResponse", () => {
  it("returns 429 with Retry-After and no internals", async () => {
    const res = tooManyResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit/i);
    expect(JSON.stringify(body)).not.toMatch(/subject|scope|postgres|sql/i);
  });
});

describe("enforceRateLimit", () => {
  const req = (ip = "1.2.3.4"): Request =>
    new Request("http://x/", { headers: { "x-forwarded-for": ip } });

  it("passes under budget without a response", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: true, count: 1, retry_after_secs: 0 }], error: null }));
    const out = await enforceRateLimit(req(), "rag-search", { userId: "u1" }, rpc);
    expect(out).toBeNull();
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_scope: "rag-search",
      p_subject: "user:u1",
      p_limit: 120,
      p_window_secs: 60,
    });
  });

  it("returns 429 + Retry-After over budget (single atomic RPC)", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: false, count: 121, retry_after_secs: 17 }], error: null }));
    const out = await enforceRateLimit(req(), "rag-search", { userId: "u1" }, rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(out?.status).toBe(429);
    expect(out?.headers.get("Retry-After")).toBe("17");
  });

  it("keys register-admin by IP even for authenticated callers", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: true, count: 1, retry_after_secs: 0 }], error: null }));
    await enforceRateLimit(req("9.9.9.9"), "register-admin", { userId: "u1", perIp: true }, rpc);
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", expect.objectContaining({ p_subject: "ip:9.9.9.9" }));
  });

  it("fails open when the RPC errors (auth/RLS still enforced downstream)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
    const out = await enforceRateLimit(req(), "ai-proxy", { userId: "u1" }, rpc);
    expect(out).toBeNull();
  });
});
