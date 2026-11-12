import { describe, expect, it, vi } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  buildPasswordResetRedirectUrl,
  completePasswordUpdate,
  requestPasswordReset,
  sanitizeRedirectNext,
  validateEmailForReset,
  validatePasswordUpdate,
  type MinimalAuthClient,
} from "./passwordReset";

describe("validateEmailForReset", () => {
  it("accepts and trims valid email addresses", () => {
    expect(validateEmailForReset("  alice@example.edu  ")).toEqual({
      ok: true,
      value: "alice@example.edu",
    });
  });

  it("rejects empty or malformed email addresses", () => {
    expect(validateEmailForReset("")).toEqual({
      ok: false,
      error: "Please enter your email address.",
    });
    expect(validateEmailForReset("   ")).toEqual({
      ok: false,
      error: "Please enter your email address.",
    });
    expect(validateEmailForReset("not-an-email")).toEqual({
      ok: false,
      error: "Please enter a valid email address.",
    });
    expect(validateEmailForReset("missing@tld")).toEqual({
      ok: false,
      error: "Please enter a valid email address.",
    });
  });
});

describe("validatePasswordUpdate", () => {
  it("accepts matching passwords meeting minimum length", () => {
    expect(validatePasswordUpdate("correct-horse-8", "correct-horse-8")).toEqual({
      ok: true,
    });
  });

  it("rejects empty, short, overly long, or mismatched passwords", () => {
    expect(validatePasswordUpdate("", "")).toEqual({
      ok: false,
      error: "Please enter a new password.",
    });
    expect(validatePasswordUpdate("short", "short")).toEqual({
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    });
    const tooLong = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    expect(validatePasswordUpdate(tooLong, tooLong)).toEqual({
      ok: false,
      error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
    });
    expect(validatePasswordUpdate("validpassword1", "validpassword2")).toEqual({
      ok: false,
      error: "Passwords do not match.",
    });
  });
});

describe("sanitizeRedirectNext", () => {
  it("allows internal relative paths", () => {
    expect(sanitizeRedirectNext("/reset-password")).toBe("/reset-password");
    expect(sanitizeRedirectNext("/settings?tab=security")).toBe("/settings?tab=security");
  });

  it("blocks open redirects to external origins or protocol-relative URLs", () => {
    expect(sanitizeRedirectNext(null)).toBe("/reset-password");
    expect(sanitizeRedirectNext("")).toBe("/reset-password");
    expect(sanitizeRedirectNext("https://evil.example.com")).toBe("/reset-password");
    expect(sanitizeRedirectNext("//evil.example.com")).toBe("/reset-password");
    expect(sanitizeRedirectNext("/\\evil.example.com")).toBe("/reset-password");
    expect(sanitizeRedirectNext("/javascript:alert(1)")).toBe("/reset-password");
    expect(sanitizeRedirectNext("/reset\r\nHeader: injected")).toBe("/reset-password");
  });
});

describe("buildPasswordResetRedirectUrl", () => {
  it("constructs the callback URL with encoded safe next path", () => {
    expect(buildPasswordResetRedirectUrl("https://workbench.example.org/")).toBe(
      "https://workbench.example.org/api/auth/callback?next=%2Freset-password",
    );
    expect(buildPasswordResetRedirectUrl("http://localhost:3000", "//evil.com")).toBe(
      "http://localhost:3000/api/auth/callback?next=%2Freset-password",
    );
  });
});

describe("requestPasswordReset & completePasswordUpdate", () => {
  it("calls resetPasswordForEmail with the callback redirectTo", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client: MinimalAuthClient = {
      auth: {
        resetPasswordForEmail,
        updateUser: vi.fn(),
      },
    };

    const res = await requestPasswordReset(
      client,
      " researcher@uni.ac.id ",
      "http://localhost:3000",
    );
    expect(res).toEqual({ ok: true });
    expect(resetPasswordForEmail).toHaveBeenCalledWith("researcher@uni.ac.id", {
      redirectTo: "http://localhost:3000/api/auth/callback?next=%2Freset-password",
    });
  });

  it("normalizes rate-limit errors from resetPasswordForEmail", async () => {
    const client: MinimalAuthClient = {
      auth: {
        resetPasswordForEmail: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "For security purposes, you can only request this once every 60 seconds" },
        }),
        updateUser: vi.fn(),
      },
    };

    const res = await requestPasswordReset(client, "a@b.co", "http://localhost:3000");
    expect(res).toEqual({
      ok: false,
      error: "Too many reset requests. Please wait a moment and try again.",
    });
  });

  it("updates the user password when validation passes", async () => {
    const updateUser = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client: MinimalAuthClient = {
      auth: {
        resetPasswordForEmail: vi.fn(),
        updateUser,
      },
    };

    const res = await completePasswordUpdate(client, "newSecurePass123", "newSecurePass123");
    expect(res).toEqual({ ok: true });
    expect(updateUser).toHaveBeenCalledWith({ password: "newSecurePass123" });
  });
});
