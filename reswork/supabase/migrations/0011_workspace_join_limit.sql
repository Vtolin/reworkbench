-- 0011: atomic workspace self-join with DB-enforced member limit (Phase 3).
--
-- The API's count-then-insert (members/route.ts) races: two concurrent joins
-- can both pass the count check and both insert. join_workspace() serializes
-- joins per workspace with pg_advisory_xact_lock(hashtext(workspace_id)),
-- then re-counts and inserts in the SAME transaction — the limit cannot be
-- overshot no matter how many callers race. The API keeps its clamp as UX
-- (fast-path messages) and passes the effective limit in; this RPC is the
-- enforcement backstop.
--
-- workspace_members has a unique (workspace_id, user_id) constraint, so a
-- double-insert would fail loudly — but the existing-row check + lock avoids
-- ever attempting one (no exception-driven control flow under race).
--
-- Rollback: drop function public.join_workspace(uuid, uuid, int);
-- RLS: unchanged (no table policies touched). The function is SECURITY
-- DEFINER but executable by service_role only; callers reach it through the
-- API, which verifies the caller IS the joining user first.
create or replace function public.join_workspace(
  p_workspace_id uuid, p_user_id uuid, p_limit int
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  existing_status text;
  current_count integer;
begin
  -- Serialize joins per workspace for the duration of this transaction.
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text));
  select status into existing_status
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id
  order by joined_at desc nulls last
  limit 1;
  -- Fail closed on any non-active row (removed, invited, unknown).
  if existing_status is not null and existing_status <> 'active' then
    return 'revoked';
  end if;
  if existing_status = 'active' then
    return 'already';
  end if;
  select count(*) into current_count
  from public.workspace_members
  where workspace_id = p_workspace_id and status = 'active';
  if current_count >= p_limit then
    return 'full';
  end if;
  insert into public.workspace_members(workspace_id, user_id, role, status)
  values (p_workspace_id, p_user_id, 'member', 'active');
  return 'ok';
end $$;

revoke all on function public.join_workspace(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.join_workspace(uuid, uuid, int) to service_role;
