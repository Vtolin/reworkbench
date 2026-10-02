import { describe, expect, it } from "vitest";
import {
  PROXY_MESSAGES_MAX_BYTES,
  TRAIL_PAYLOAD_MAX_BYTES,
  isOverLimit,
  jsonByteLength,
  tooLargeResponse,
} from "./sizeLimits";

describe("size caps", () => {
  it("names the mandated budgets (32KB trail, 256KB proxy)", () => {
    expect(TRAIL_PAYLOAD_MAX_BYTES).toBe(32 * 1024);
    expect(PROXY_MESSAGES_MAX_BYTES).toBe(256 * 1024);
  });

  it("measures UTF-8 bytes, not JS string length", () => {
    expect(jsonByteLength("é")).toBe(4); // JSON quotes + 2-byte char (3 chars, 4 bytes)
    expect(jsonByteLength({}).valueOf()).toBeGreaterThan(0);
    expect(isOverLimit("x".repeat(100), 50)).toBe(true);
    expect(isOverLimit("x".repeat(10), 50)).toBe(false);
    // Multibyte payload that fits in .length but not in bytes.
    expect(isOverLimit("é".repeat(20_000), TRAIL_PAYLOAD_MAX_BYTES)).toBe(true);
  });

  it("treats missing payloads as empty (never NaN/throw)", () => {
    expect(jsonByteLength(undefined)).toBe(4); // "null"
    expect(isOverLimit(undefined, 10)).toBe(false);
  });

  it("returns 413 with a budget-only message", async () => {
    const res = tooLargeResponse("payload", TRAIL_PAYLOAD_MAX_BYTES);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("32768");
  });
});
