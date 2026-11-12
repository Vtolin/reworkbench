import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}));

import { GET } from "./route";

describe("GET /api/auth/callback", () => {
  beforeEach(() => {
    mocks.exchangeCodeForSession.mockReset();
    mocks.verifyOtp.mockReset();
  });

  it("exchanges a PKCE code and redirects to /reset-password", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    const req = new Request(
      "http://localhost:3000/api/auth/callback?code=pkce_123&next=%2Freset-password",
    );
    const res = await GET(req);

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("pkce_123");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/reset-password");
  });

  it("neutralizes open-redirect attempts in the next parameter", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    const req = new Request(
      "http://localhost:3000/api/auth/callback?code=pkce_123&next=https%3A%2F%2Fevil.example.com",
    );
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/reset-password");
  });

  it("verifies a recovery token_hash and redirects to the safe destination", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: null });

    const req = new Request(
      "http://localhost:3000/api/auth/callback?token_hash=th_abc&type=recovery&next=%2Freset-password",
    );
    const res = await GET(req);

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "th_abc",
      type: "recovery",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/reset-password");
  });

  it("redirects to /forgot-password with error when code exchange fails", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      data: null,
      error: { message: "AuthApiError: invalid flow state" },
    });

    const req = new Request("http://localhost:3000/api/auth/callback?code=bad_code");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/forgot-password?error=invalid_or_expired_link",
    );
  });

  it("redirects to /forgot-password when upstream error or missing params occur", async () => {
    const reqErr = new Request(
      "http://localhost:3000/api/auth/callback?error=access_denied&error_code=otp_expired",
    );
    const resErr = await GET(reqErr);
    expect(resErr.headers.get("location")).toBe(
      "http://localhost:3000/forgot-password?error=invalid_or_expired_link",
    );

    const reqEmpty = new Request("http://localhost:3000/api/auth/callback");
    const resEmpty = await GET(reqEmpty);
    expect(resEmpty.headers.get("location")).toBe(
      "http://localhost:3000/forgot-password?error=invalid_or_expired_link",
    );
  });
});
