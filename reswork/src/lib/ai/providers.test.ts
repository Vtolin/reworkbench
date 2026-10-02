import { describe, expect, it } from "vitest";
import { buildGoogleExtraBody, isGemini3, upstreamError } from "./providers";

describe("isGemini3", () => {
  it("matches Gemini 3 model ids case-insensitively", () => {
    expect(isGemini3("gemini-3-pro")).toBe(true);
    expect(isGemini3("Gemini-3.5-Flash")).toBe(true);
    expect(isGemini3("gemini-2.5-flash")).toBe(false);
    expect(isGemini3("")).toBe(false);
  });
});

describe("buildGoogleExtraBody", () => {
  it("maps explicit thinking:false to minimal on Gemini 3, budget 0 on 2.5", () => {
    expect(buildGoogleExtraBody({ model: "gemini-3-pro", thinking: false })).toEqual({
      google: { thinking_config: { thinking_level: "minimal" } },
    });
    expect(buildGoogleExtraBody({ model: "gemini-2.5-flash", thinking: false })).toEqual({
      google: { thinking_config: { thinking_budget: 0 } },
    });
  });

  it("never sends budget and level together on Gemini 3", () => {
    const body = buildGoogleExtraBody({ model: "gemini-3-pro", thinkingBudget: 1024, thinkLevel: "low" });
    expect(body).toEqual({ google: { thinking_config: { thinking_level: "low" } } });
  });
});

describe("upstreamError", () => {
  it("shapes key-free diagnosable messages", () => {
    expect(upstreamError("openai", 401, "")).toBe("openai error: 401");
    expect(upstreamError("openai", 400, '{"error":{"message":"bad key"}}')).toContain("bad key");
    expect(upstreamError("openai", 500, "boom")).toContain("boom");
  });
});
