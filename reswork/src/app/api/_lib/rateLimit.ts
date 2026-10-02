import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { errorCategory, logEvent } from "@/lib/observability/log";

// Postgres-backed fixed-window rate limiting (Phase 3).
//
// Vercel is serverless: in-memory buckets are per-instance and unreliable, so
// every check goes through the atomic check_rate_limit() RPC (migration
// 0010): one INSERT ... ON CONFLICT DO UPDATE returning the window count.
// Scopes are per-feature; subjects are `user:<id>` (authenticated routes) or
// `ip:<addr>` (register-admin key-guessing protection). Limits are env
// overrides (RATE_LIMIT_<SCOPE>_MAX / _WINDOW_SECS) with sane defaults below.
// 429s carry Retry-After and are logged with errorCategory("rate_limit").
//
// Fail-open: if the RPC itself errors, the request proceeds (rate limiting is
// defense-in-depth; auth/RLS still enforced) and the outage is logged.

export type RateLimitScope =
  | "register-admin"
  | "ai-proxy"
  | "rag-embed"
  | "rag-search"
  | "research-trail";

interface RateLimitConfig {
  max: number;
  windowSecs: number;
}

const DEFAULTS: Record<RateLimitScope, RateLimitConfig> = {
  // Key-guessing protection: strict per-IP bucket on the anonymous bootstrap.
  "register-admin": { max: 5, windowSecs: 3600 },
  // Billed inference/embedding calls: generous per-user budgets, not gates.
  "ai-proxy": { max: 60, windowSecs: 60 },
  "rag-embed": { max: 120, windowSecs: 60 },
  "rag-search": { max: 120, windowSecs: 60 },
  "research-trail": { max: 200, windowSecs: 60 },
};

function envInfix(scope: RateLimitScope): string {
  return scope.toUpperCase().replace(/-/g, "_");
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Effective limit/window for a scope (env override or default). Pure. */
export function resolveRateLimit(scope: RateLimitScope): RateLimitConfig {
  const infix = envInfix(scope);
  const fallback = DEFAULTS[scope];
  return {
    max: envPositiveInt(`RATE_LIMIT_${infix}_MAX`, fallback.max),
    windowSecs: envPositiveInt(`RATE_LIMIT_${infix}_WINDOW_SECS`, fallback.windowSecs),
  };
}

/** First client IP from proxy headers. Pure. */
export function getClientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real || null;
}

/** Bucket subject: per-IP for anonymous scopes, per-user otherwise. Pure. */
export function rateLimitSubject(opts: { userId?: string | null; ip: string | null; perIp: boolean }): string {
  if (!opts.perIp && opts.userId) return `user:${opts.userId}`;
  return `ip:${opts.ip ?? "unknown"}`;
}

/** 429 + Retry-After response. Pure (logging happens at the call site). */
export function tooManyResponse(retryAfterSecs: number): NextResponse {
  const retryAfter = Math.max(1, Math.floor(retryAfterSecs || 60));
  return NextResponse.json(
    { error: "Rate limit exceeded, retry later" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterSecs: number;
}

type RpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/** Default RPC caller: service role (table is RLS-deny-all; RPC is the gate). */
async function serviceRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
  const service = createServiceSupabase();
  const { data, error } = await service.rpc(fn, args);
  return { data, error: error ? { message: error.message } : null };
}

/**
 * Enforce the scope budget. Returns a 429 response when over budget, else
 * null (proceed). `rpc` is injectable for tests; production uses serviceRpc.
 */
export async function enforceRateLimit(
  req: Request,
  scope: RateLimitScope,
  opts: { userId?: string | null; perIp?: boolean; requestId?: string } = {},
  rpc: RpcCaller = serviceRpc,
): Promise<NextResponse | null> {
  const { max, windowSecs } = resolveRateLimit(scope);
  const subject = rateLimitSubject({ userId: opts.userId, ip: getClientIp(req), perIp: opts.perIp ?? false });
  let check: RateLimitCheck;
  try {
    const { data, error } = await rpc("check_rate_limit", {
      p_scope: scope,
      p_subject: subject,
      p_limit: max,
      p_window_secs: windowSecs,
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : null) as {
      allowed?: boolean;
      retry_after_secs?: number;
    } | null;
    if (!row || typeof row.allowed !== "boolean") throw new Error("malformed rate-limit response");
    check = { allowed: row.allowed, retryAfterSecs: Number(row.retry_after_secs ?? windowSecs) };
  } catch (e) {
    logEvent("warn", "rate_limit.unavailable", {
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
      scope,
      errorCategory: errorCategory(e),
    });
    return null;
  }
  if (check.allowed) return null;
  logEvent("warn", "rate_limit.exceeded", {
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    scope,
    errorCategory: errorCategory("rate limit exceeded"),
    retryAfterSecs: check.retryAfterSecs,
  });
  return tooManyResponse(check.retryAfterSecs);
}
