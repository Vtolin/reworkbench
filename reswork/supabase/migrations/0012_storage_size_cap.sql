-- 0012: size cap on documents-bucket uploads (Phase 3: safety).
--
-- The insert policy from 0002 allowed unbounded object sizes: one huge upload
-- could exhaust bucket quota and stall ingest. Recreate it with a WITH CHECK
-- size predicate (50MB default research-paper ceiling). Existing objects are
-- untouched (INSERT-only predicate); updates/deletes keep their 0002 policies.
--
-- The NULL arm matters: storage populates metadata.size server-side, but a
-- missing key must not brick uploads outright (fail open on unknown, closed
-- on known-oversize). The signed-URL server route remains the first layer.
--
-- Rollback: drop policy "documents_bucket_insert_members" on storage.objects;
--   re-apply supabase/migrations/0002_storage.sql.
-- RLS: storage.objects policies only; no application-table policy touched.
drop policy if exists "documents_bucket_insert_members" on storage.objects;
create policy "documents_bucket_insert_members"
on storage.objects for insert with check (
  bucket_id = 'documents'
  and (
    (metadata ->> 'size') is null
    or (metadata ->> 'size')::bigint <= 52428800
  )
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and position(m.workspace_id::text in name) = 1
  )
);
