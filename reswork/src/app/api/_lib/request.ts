import { randomUUID } from "node:crypto";
import { errorCategory, logEvent } from "@/lib/observability/log";

// Request/correlation ids (Phase 7).
//
// Every API handler mints (or propagates) one id per request and threads it
// through every logEvent for that request, plus a completion line with
// duration and status. Correlate client → server by sending x-request-id
// (the ask client does); otherwise a fresh id is generated. Ids are opaque
// nonces — never user data — and safe to return in the x-request-id
// response header for support correlation.

/** Fresh opaque request id. Pure. */
export function newRequestId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Correlate with the caller: honor a client-supplied x-request-id, else
 * mint. Pure. Trims + length-caps the foreign value (header injection
 * must not become a log-injection vector).
 */
export function getRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id")?.trim();
  if (incoming && /^[\w\-.]{1,128}$/.test(incoming)) return incoming;
  return newRequestId();
}

/** Attach the id to a JSON response for support correlation. Pure. */
export function withRequestId<T extends Response>(res: T, requestId: string): T {
  res.headers.set("x-request-id", requestId);
  return res;
}

/**
 * Completion line for one request: operation, duration, outcome. Call once
 * per handler exit (success or failure) — never with prompts, keys, bodies,
 * or row contents (redact() is the backstop, but don't pass them at all).
 */
export function logRequest(
  requestId: string,
  operation: string,
  startedMs: number,
  ok: boolean,
  extra: Record<string, unknown> = {},
): void {
  // `error` shapes the category only — raw error text never hits the log.
  const { error, ...rest } = extra;
  logEvent(ok ? "info" : "error", operation, {
    requestId,
    durationMs: Date.now() - startedMs,
    ok,
    ...(ok ? {} : { errorCategory: errorCategory(error ?? "request failed") }),
    ...rest,
  });
}
