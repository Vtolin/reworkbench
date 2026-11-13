// Lightweight, dependency-free error reporting. Sentry/other providers can be
// wired later by replacing `send` with their SDK call; until then this emits a
// structured log (and, when configured, POSTs to an endpoint) so failures are
// never silently swallowed. Never throws - reporting must not break the app.
export interface ErrorContext {
  [key: string]: unknown;
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const payload = {
    level: "error",
    message,
    stack,
    context,
    timestamp: new Date().toISOString(),
  };
  // Structured console log (picked up by log drains in production).
  console.error("[report]", JSON.stringify(payload));
  const endpoint = process.env.NEXT_PUBLIC_ERROR_REPORT_URL;
  if (endpoint && typeof fetch === "function") {
    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}
