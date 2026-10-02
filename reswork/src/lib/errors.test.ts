import { describe, expect, it, vi } from "vitest";
import { isInfrastructureErrorText, toUserMessage } from "./errors";

describe("isInfrastructureErrorText", () => {
  it("flags Postgres/RLS/network/stack text", () => {
    expect(isInfrastructureErrorText('relation "public.documents" does not exist')).toBe(true);
    expect(isInfrastructureErrorText("new row violates row-level security policy")).toBe(true);
    expect(isInfrastructureErrorText("duplicate key value violates unique constraint")).toBe(true);
    expect(isInfrastructureErrorText("Failed to fetch")).toBe(true);
    expect(isInfrastructureErrorText("Error: foo\n    at bar (x.js:1:2)")).toBe(true);
  });

  it("passes ordinary app messages", () => {
    expect(isInfrastructureErrorText("Document not found")).toBe(false);
    expect(isInfrastructureErrorText("Popup blocked — allow popups to export PDF")).toBe(false);
    expect(isInfrastructureErrorText("")).toBe(false);
  });
});

describe("toUserMessage", () => {
  it("passes ordinary errors through unchanged", () => {
    expect(toUserMessage(new Error("Document not found"))).toBe("Document not found");
    expect(toUserMessage("plain string failure")).toBe("plain string failure");
  });

  it("replaces infrastructure text with the fallback and logs once", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(toUserMessage(new Error('permission denied for table documents'))).toBe("Something went wrong");
      expect(toUserMessage(new Error("permission denied for table t"), "Custom fallback")).toBe("Custom fallback");
      expect(toUserMessage(null)).toBe("Something went wrong");
      expect(err).toHaveBeenCalledTimes(2);
    } finally {
      err.mockRestore();
    }
  });
});
