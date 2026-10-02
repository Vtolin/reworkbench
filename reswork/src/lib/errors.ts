// User-facing error shaping (Phase 15).
//
// Browser-first flows surface Supabase/Postgres/network failures directly in
// toasts, alerts, and chat bubbles. Most messages are safe and actionable
// ("Document not found"), but infrastructure text (Postgres diagnostics,
// RLS internals, fetch TypeErrors, stack traces) must never reach users —
// details go to the console for debugging instead.
//
// Contract: ordinary Error messages pass through UNCHANGED (no behavior
// change for the common case); only infra-shaped text becomes the fallback.

const INFRA_PATTERNS: RegExp[] = [
  /relation .* does not exist/i,
  /permission denied for/i,
  /violates .*constraint/i,
  /new row violates/i,
  /row-level security/i,
  /postgrest/i,
  /\bPGRST\d+/,
  /JWT (expired|invalid)/i,
  /Failed to fetch|NetworkError|Load failed/i,
  /at .*:\d+:\d+/,
  /Error: .*Error:/,
];

export function isInfrastructureErrorText(text: string): boolean {
  return INFRA_PATTERNS.some((re) => re.test(text ?? ""));
}

/** Shape an unknown throw into a safe user-facing message. */
export function toUserMessage(e: unknown, fallback = "Something went wrong"): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (!msg) return fallback;
  if (isInfrastructureErrorText(msg)) {
    // Keep the diagnostic where developers look; users get the fallback.
    console.error("[suppressed internal error]", msg.slice(0, 500));
    return fallback;
  }
  return msg;
}
