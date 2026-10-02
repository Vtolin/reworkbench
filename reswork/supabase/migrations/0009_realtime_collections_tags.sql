-- 0009: realtime publication for collections/tags (Phase 2: kill the 5s poller).
--
-- The Sidebar and library directory lists refresh from realtime events on
-- documents, collections and tags instead of polling every 5s. Realtime only
-- delivers events for tables in the supabase_realtime publication; without
-- these two, collection/tag changes would be invisible until the 60s
-- hidden-aware fallback poll. documents was already published (see 0001).
--
-- Rollback: alter publication supabase_realtime drop table public.collections, public.tags;
-- RLS: unchanged. Publication membership does not alter policies; realtime
-- still enforces each subscriber's RLS, and every table keeps its policies.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'collections'
  ) then
    alter publication supabase_realtime add table public.collections;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tags'
  ) then
    alter publication supabase_realtime add table public.tags;
  end if;
end $$;
