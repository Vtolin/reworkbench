// Bounded network primitives for external calls (Task N).
//
// Every external fetch in this codebase must answer: what is the timeout,
// what is retried, and what is never retried. These helpers encode the
// policy once:
// - fetchWithTimeout: every outbound request gets an explicit deadline. A
//   hung socket otherwise hangs the caller forever (Vercel function, ingest
//   loop, metadata lookup). Caller cancellation still propagates as a plain
//   AbortError and is NEVER retried.
// - withRetry: bounded retries with exponential backoff for retryable
//   failures ONLY (timeouts, network-level TypeErrors, HTTP 408/429/5xx).
//   Validation errors, auth failures, and caller cancellation fail fast.
//   No jitter: single-client browser workloads gain nothing from it, and
//   deterministic backoff keeps tests exact.
//
// What is deliberately NOT retried here: billed inference/embedding calls
// (proxy, rag/embed routes). Retrying those doubles cost and can double
// side effects; a failure surfaces to the user, who retries explicitly.
// Free idempotent GETs (OpenAlex) may retry.
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** Statuses worth one more attempt: rate-limited, overloaded, or mid-deploy. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableError(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof HttpStatusError) return isRetryableStatus(e.status);
  // Caller cancellation (AbortController / component unmount): never retry.
  if (e instanceof DOMException && e.name === "AbortError") return false;
  // fetch rejects with TypeError on DNS / refused / reset / CORS failures.
  if (e instanceof TypeError) return true;
  return false;
}

/**
 * fetch with an explicit deadline. Rejects with TimeoutError when OUR timer
 * fires; rejects with the caller's AbortError when THEIR signal fires.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const external = init?.signal;
  if (external?.aborted) return fetch(input, init);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new TimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

export interface RetryPolicy {
  /** Total attempts including the first (default 2 = one retry). */
  maxAttempts?: number;
  /** First backoff delay (default 500ms); doubles per retry. */
  baseDelayMs?: number;
  /** Backoff ceiling (default 4000ms). */
  maxDelayMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn until it succeeds, the policy is exhausted, or the error is not
 * retryable (rehtrown immediately — no sleep, no extra attempts).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts ?? 2));
  const base = Math.max(0, policy.baseDelayMs ?? 500);
  const ceiling = Math.max(base, policy.maxDelayMs ?? 4000);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts || !isRetryableError(e)) throw e;
      await sleep(Math.min(ceiling, base * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
