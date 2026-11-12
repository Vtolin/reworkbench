import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";
import { sanitizeRedirectNext } from "@/lib/auth/passwordReset";
import { getRequestId } from "@/app/api/_lib/request";
import { errorCategory, logEvent } from "@/lib/observability/log";

const ALLOWED_OTP_TYPES = new Set<EmailOtpType>([
  "recovery",
  "signup",
  "invite",
  "magiclink",
  "email",
  "email_change",
]);

function resolveOtpType(raw: string | null): EmailOtpType {
  if (raw && ALLOWED_OTP_TYPES.has(raw as EmailOtpType)) {
    return raw as EmailOtpType;
  }
  return "recovery";
}

// GET /api/auth/callback
// Exchanges a Supabase PKCE `?code=` or verifies a `?token_hash=&type=recovery`
// email link on the server (setting session cookies via @supabase/ssr) before
// redirecting to the sanitized internal destination (default: /reset-password).
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const started = Date.now();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const rawType = url.searchParams.get("type");
  const upstreamError = url.searchParams.get("error");
  const next = sanitizeRedirectNext(url.searchParams.get("next"), "/reset-password");

  const failRedirect = () =>
    NextResponse.redirect(
      new URL("/forgot-password?error=invalid_or_expired_link", url.origin),
    );

  if (upstreamError) {
    logEvent("warn", "auth.callback", {
      requestId,
      durationMs: Date.now() - started,
      ok: false,
      errorCategory: "auth",
    });
    return failRedirect();
  }

  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      logEvent("info", "auth.callback", {
        requestId,
        durationMs: Date.now() - started,
        ok: true,
        flow: "pkce",
      });
      return NextResponse.redirect(new URL(next, url.origin));
    }
    logEvent("warn", "auth.callback", {
      requestId,
      durationMs: Date.now() - started,
      ok: false,
      flow: "pkce",
      errorCategory: errorCategory(error),
    });
    return failRedirect();
  }

  if (tokenHash) {
    const supabase = await createServerSupabase();
    const otpType = resolveOtpType(rawType);
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (!error) {
      logEvent("info", "auth.callback", {
        requestId,
        durationMs: Date.now() - started,
        ok: true,
        flow: "otp",
      });
      return NextResponse.redirect(new URL(next, url.origin));
    }
    logEvent("warn", "auth.callback", {
      requestId,
      durationMs: Date.now() - started,
      ok: false,
      flow: "otp",
      errorCategory: errorCategory(error),
    });
    return failRedirect();
  }

  logEvent("warn", "auth.callback", {
    requestId,
    durationMs: Date.now() - started,
    ok: false,
    errorCategory: "validation",
  });
  return failRedirect();
}
