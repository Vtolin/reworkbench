// Password reset & recovery helpers (pure domain + Supabase auth client wiring).
// Kept free of UI/React imports so both browser flows and unit tests can share
// the exact validation, open-redirect sanitization, and Supabase calls.

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export interface MinimalAuthClient {
  auth: {
    resetPasswordForEmail: (
      email: string,
      options?: { redirectTo?: string },
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    updateUser: (
      attributes: { password: string },
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

export type ValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates an email address before initiating a password reset request.
 */
export function validateEmailForReset(rawEmail: string): ValidationResult {
  const email = (rawEmail ?? "").trim();
  if (!email) {
    return { ok: false, error: "Please enter your email address." };
  }
  // Simple, ReDoS-safe structural check: non-whitespace local@domain.tld
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  return { ok: true, value: email };
}

/**
 * Validates a new password and its confirmation.
 */
export function validatePasswordUpdate(
  password: string,
  confirmPassword: string,
): { ok: true } | { ok: false; error: string } {
  if (!password) {
    return { ok: false, error: "Please enter a new password." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
    };
  }
  if (password !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }
  return { ok: true };
}

/**
 * Sanitizes a post-auth redirect target to prevent Open Redirect attacks (CWE-601).
 * Only permits internal relative paths beginning with a single `/`.
 */
export function sanitizeRedirectNext(
  nextParam: string | null | undefined,
  fallback = "/reset-password",
): string {
  if (!nextParam || typeof nextParam !== "string") return fallback;
  const trimmed = nextParam.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    /^\/[a-zA-Z0-9+.-]+:/.test(trimmed) ||
    /[\r\n\t]/.test(trimmed)
  ) {
    return fallback;
  }
  return trimmed;
}

/**
 * Builds the callback URL sent in the Supabase recovery email.
 * Routes through `/api/auth/callback` so server-side PKCE code or token_hash
 * exchange sets cookies before landing on `/reset-password`.
 */
export function buildPasswordResetRedirectUrl(
  origin: string,
  nextPath = "/reset-password",
): string {
  const cleanOrigin = origin.trim().replace(/\/+$/, "");
  const safeNext = sanitizeRedirectNext(nextPath, "/reset-password");
  return `${cleanOrigin}/api/auth/callback?next=${encodeURIComponent(safeNext)}`;
}

/**
 * Sends a password reset email via Supabase Auth.
 */
export async function requestPasswordReset(
  client: MinimalAuthClient,
  rawEmail: string,
  origin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const check = validateEmailForReset(rawEmail);
  if (!check.ok) return check;

  const redirectTo = buildPasswordResetRedirectUrl(origin, "/reset-password");
  const { error } = await client.auth.resetPasswordForEmail(check.value, {
    redirectTo,
  });

  if (error) {
    // Surface rate-limit messages clearly; otherwise return a safe message.
    if (/rate limit|too many|security purposes/i.test(error.message)) {
      return {
        ok: false,
        error: "Too many reset requests. Please wait a moment and try again.",
      };
    }
    return { ok: false, error: error.message || "Failed to send reset email." };
  }

  return { ok: true };
}

/**
 * Completes a password update for the currently authenticated / recovery user.
 */
export async function completePasswordUpdate(
  client: MinimalAuthClient,
  password: string,
  confirmPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const check = validatePasswordUpdate(password, confirmPassword);
  if (!check.ok) return check;

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    return {
      ok: false,
      error: error.message || "Could not update password. Your reset link may have expired.",
    };
  }
  return { ok: true };
}
