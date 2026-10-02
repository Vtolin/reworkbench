// Lightweight structured operation logging (Task O).
//
// Deliberately boring: one JSON line per completed operation on the console,
// where the existing deployment already collects stdout. No SDK, no sampling,
// no PII. Every field passes through redact(): keys, tokens, ciphertext,
// and authorization material can never be logged, even if a caller passes
// a whole request body by accident.
//
// Log only operation facts: name, duration, batch sizes, counts, provider,
// retry/attempt counts, failure category. Never: API keys, credentials,
// document text, user messages, authorization secrets.
const SENSITIVE_KEY_RE = /api[\s_-]?key|token|secret|cipher|password|passwd|auth|credential|session|cookie|bearer|x-api-key/i;

const MAX_STRING_CHARS = 2000;
const MAX_DEPTH = 5;

/** Deep-clone value with sensitive keys replaced and huge strings clipped. */
export function redact<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return (value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]` : value) as T;
  }
  if (typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out as T;
}

export type LogLevel = "info" | "warn" | "error";

/** Single structured line. Never throws (logging must not break the operation). */
export function logEvent(level: LogLevel, operation: string, fields: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      op: operation,
      ...redact(fields),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    /* logging is best-effort */
  }
}

/** Coarse failure category for dashboards/alerts (no message text attached). */
export function errorCategory(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/abort|timeout|timed out/i.test(msg)) return "timeout";
  if (/network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return "network";
  if (/rate.?limit|429|quota|overloaded/i.test(msg)) return "rate_limit";
  if (/unauthorized|unauthenticated|forbidden|401|403|\bjwt\b/i.test(msg)) return "auth";
  if (/valid|invalid|required|bad request|\b400\b/i.test(msg)) return "validation";
  return "internal";
}

/**
 * Time an async operation and log one completion line (success with
 * durationMs, failure with durationMs + errorCategory). Rethrows failures
 * unchanged — observation only, never policy.
 */
export async function timeOperation<T>(
  operation: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logEvent("info", operation, { ...fields, durationMs: Date.now() - start, ok: true });
    return result;
  } catch (e) {
    logEvent("error", operation, {
      ...fields,
      durationMs: Date.now() - start,
      ok: false,
      errorCategory: errorCategory(e),
    });
    throw e;
  }
}
