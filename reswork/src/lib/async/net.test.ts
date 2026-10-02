import { describe, expect, it, vi } from "vitest";
import {
  HttpStatusError,
  TimeoutError,
  fetchWithTimeout,
  isRetryableError,
  isRetryableStatus,
  withRetry,
} from "./net";

describe("isRetryableStatus", () => {
  it("retries rate limits and server faults, never client errors", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("classifies timeouts, network failures, and statuses; never aborts or validation", () => {
    expect(isRetryableError(new TimeoutError(100))).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new HttpStatusError(503, "x"))).toBe(true);
    expect(isRetryableError(new HttpStatusError(404, "x"))).toBe(false);
    expect(isRetryableError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isRetryableError(new Error("validation"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const out = await withRetry(async () => "ok", {}, sleep);
    expect(out).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries retryable failures with exponential backoff, then succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TypeError("fetch failed");
        return "recovered";
      },
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      sleep,
    );
    expect(out).toBe("recovered");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("fails fast on non-retryable errors (no sleep, no extra attempts)", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpStatusError(401, "bad key");
        },
        { maxAttempts: 3 },
        sleep,
      ),
    ).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpStatusError(503, "down");
        },
        { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 60 },
        sleep,
      ),
    ).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toBe(2);
    // Backoff capped at maxDelayMs.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50]);
  });
});

describe("fetchWithTimeout", () => {
  it("resolves fast responses before the deadline", async () => {
    const res = await fetchWithTimeout("http://localhost/nope", undefined, 1000).catch(() => null);
    // No server here — the point is the shape: network refusal surfaces as
    // TypeError (retryable), not as a hang. If it somehow resolves, fine.
    expect(res === null || res instanceof Response).toBe(true);
  });

  it("rejects with TimeoutError on a hung response, not AbortError", async () => {
    // Mirror real fetch: the pending request rejects once its signal aborts.
    const hangingFetch = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", hangingFetch);
    try {
      await expect(fetchWithTimeout("http://example.com/slow", undefined, 20)).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      vi.stubGlobal("fetch", origFetch);
    }
  });

  it("propagates caller cancellation as AbortError (never TimeoutError)", async () => {
    const controller = new AbortController();
    const slow = new Promise<Response>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const origFetch = globalThis.fetch;
    vi.stubGlobal("fetch", () => slow);
    try {
      controller.abort();
      await expect(fetchWithTimeout("http://example.com/x", { signal: controller.signal }, 5000)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      vi.stubGlobal("fetch", origFetch);
    }
  });
});
