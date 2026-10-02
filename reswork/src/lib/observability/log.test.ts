import { afterEach, describe, expect, it, vi } from "vitest";
import { errorCategory, logEvent, redact, timeOperation } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redact", () => {
  it("replaces sensitive keys at any depth and keeps safe fields", () => {
    const out = redact({
      provider: "openai",
      apiKey: "sk-live-123",
      nested: { ciphertext: "abc", model: "gpt-4o" },
      list: [{ token: "t", count: 3 }],
    });
    expect(out).toEqual({
      provider: "openai",
      apiKey: "[redacted]",
      nested: { ciphertext: "[redacted]", model: "gpt-4o" },
      list: [{ token: "[redacted]", count: 3 }],
    });
  });

  it("clips huge strings (document text must never fill the logs)", () => {
    const out = redact({ content: "x".repeat(5000) }) as { content: string };
    expect(out.content.length).toBeLessThan(5000);
    expect(out.content).toMatch(/\[truncated\]$/);
  });

  it("passes scalars through untouched", () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact("short")).toBe("short");
  });
});

describe("errorCategory", () => {
  it("maps messages to coarse categories without leaking text", () => {
    expect(errorCategory(new Error("Aborted"))).toBe("timeout");
    expect(errorCategory(new Error("fetch failed"))).toBe("network");
    expect(errorCategory(new Error("429 rate limit"))).toBe("rate_limit");
    expect(errorCategory(new Error("Unauthorized"))).toBe("auth");
    expect(errorCategory(new Error("text is required"))).toBe("validation");
    expect(errorCategory(new Error("weird postgres thing"))).toBe("internal");
  });
});

describe("logEvent", () => {
  it("emits one JSON line with redacted fields and never throws", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("info", "probe.op", { apiKey: "sk-x", count: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", op: "probe.op", apiKey: "[redacted]", count: 2 });
    expect(line.ts).toBeTruthy();
  });

  it("routes errors to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("error", "probe.fail", { errorCategory: "internal" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("timeOperation", () => {
  it("logs duration + ok on success and returns the value", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await timeOperation("probe.work", { batch: 4 }, async () => "done");
    expect(out).toBe("done");
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ op: "probe.work", batch: 4, ok: true });
    expect(typeof line.durationMs).toBe("number");
  });

  it("logs errorCategory and rethrows the original error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("fetch failed");
    await expect(timeOperation("probe.work", {}, async () => { throw boom; })).rejects.toBe(boom);
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ op: "probe.work", ok: false, errorCategory: "network" });
  });
});
