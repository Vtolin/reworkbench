# Deployment: Supabase connection scaling (Phase 5)

Vercel serverless functions open short-lived database connections per
invocation. Without pooling, traffic spikes exhaust Postgres
`max_connections` (each idle backend costs RAM; Supabase caps direct
connections per plan). This project therefore talks to Postgres through the
Supabase connection pooler — no per-request client reuse is needed or wanted
for the RLS-aware path (it is cookie-scoped by design), and the stateless
service client is module-cached (see `lib/supabase/server.ts`).

## Required setup (Supabase dashboard → Database → Connection pooling)

- **Mode: Transaction.** The app holds no session-level state: every query is
  an independent statement or a single RPC call, all `SECURITY DEFINER`
  functions are `SET search_path`-locked, and the retrieval RPCs carry their
  own `statement_timeout`. Transaction mode is therefore safe and gives the
  highest concurrency. Do NOT use Session mode unless a future migration
  requires advisory locks held across statements visible to the pooler —
  `pg_advisory_xact_lock` (migration 0011) is transaction-scoped by design
  and works in Transaction mode.
- **Pool size:** start with the Supabase default (matches the plan); raise
  only if `pg_stat_activity` shows pool waits during peak ingest.
- **Connection string:** use the **pooler** URL (port 6543) for
  `NEXT_PUBLIC_SUPABASE_URL` in Vercel. The direct URL (5432) is for
  migrations/local only.
- **Prepared statements:** Supabase-js disables them by default over the
  pooler path used here; do not enable `statement_cache` without re-testing
  the RPCs (named prepared statements + Transaction mode = errors).

## What the code does (and deliberately does not)

- `createServerSupabase()` is constructed per request: it forwards the
  caller's session cookies so RLS sees `auth.uid()`. Sharing it across
  requests would leak sessions — never cache it.
- `createServiceSupabase()` is module-cached: no cookies, no token refresh,
  key from server-only env. Safe to reuse.
- Migrations 0010–0014 keep transactions short (single-statement DDL,
  index builds without `CONCURRENTLY` are fast catalog writes on these
  small tables; revisit with `CONCURRENTLY` only if a table outgrows
  maintenance windows — note it cannot run inside the migration
  transaction).
- Long-running work (ingest embedding loops, exports) is bounded client-side
  (`mapWithLimit(4)`, 1000-row export pages) so no function holds a pool
  slot for minutes.
