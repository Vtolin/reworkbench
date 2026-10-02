-- 0010: Postgres-backed rate limiting (Phase 3: safety).
--
-- Vercel is serverless, so in-memory buckets are per-instance and unreliable.
-- This table backs a fixed-window counter checked-and-incremented atomically
-- by check_rate_limit() (single INSERT ... ON CONFLICT DO UPDATE returning
-- the window count). Keyed by (scope, subject, window_start) where subject is
-- `user:<uuid>` (authenticated routes) or `ip:<addr>` (register-admin).
--
-- Cleanup: the RPC opportunistically deletes expired windows for the same
-- (scope, subject) on every call. For cross-subject hygiene, operators may
-- schedule `delete from public.rate_limit_buckets where window_start <
-- now() - interval '7 days'` (Supabase scheduled webhook / pg_cron).
--
-- Rollback: drop function public.check_rate_limit(text, text, int, int);
--   drop table public.rate_limit_buckets;
-- RLS: enabled with NO policies — anon/authenticated can neither read nor
-- write. Only the service role (bypasses RLS) and this SECURITY DEFINER RPC
-- touch the table.
create table if not exists public.rate_limit_buckets (
  scope text not null,
  subject text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (scope, subject, window_start)
);

alter table public.rate_limit_buckets enable row level security;

create or replace function public.check_rate_limit(
  p_scope text, p_subject text, p_limit int, p_window_secs int
)
returns table (allowed boolean, count integer, retry_after_secs integer)
language plpgsql security definer set search_path = public as $$
declare
  ws timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  current_count integer;
begin
  -- Opportunistic cleanup: expired windows for this subject never accumulate.
  delete from public.rate_limit_buckets
  where scope = p_scope and subject = p_subject and window_start < ws;
  -- Atomic check-and-increment: concurrent callers serialize on the PK.
  insert into public.rate_limit_buckets(scope, subject, window_start, count)
  values (p_scope, p_subject, ws, 1)
  on conflict (scope, subject, window_start)
  do update set count = rate_limit_buckets.count + 1
  returning rate_limit_buckets.count into current_count;
  if current_count <= p_limit then
    return query select true, current_count, 0;
  else
    return query select
      false,
      current_count,
      (extract(epoch from (ws + make_interval(secs => p_window_secs) - now()))::integer);
  end if;
end $$;

-- Least privilege: nobody calls this directly except the service role
-- (server routes). Authenticated callers go through the API, never the RPC.
revoke all on function public.check_rate_limit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, text, int, int) to service_role;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;
