-- Storage RLS for the `documents` bucket.
-- Path convention: "<workspace_id>/<sha256>.<ext>"
-- Uploads go through signed-URL server routes that verify membership first,
-- so these policies are a second layer, not the only layer.

-- Members can read files in their workspace prefix.
drop policy if exists "documents_bucket_read_members" on storage.objects;
create policy "documents_bucket_read_members"
on storage.objects for select using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and position(m.workspace_id::text in name) = 1
  )
);

-- Authenticated users may upload into a workspace prefix they belong to
-- (server route mints the exact path; this blocks cross-workspace writes).
drop policy if exists "documents_bucket_insert_members" on storage.objects;
create policy "documents_bucket_insert_members"
on storage.objects for insert with check (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and position(m.workspace_id::text in name) = 1
  )
);

-- Only workspace admins may delete stored files.
drop policy if exists "documents_bucket_delete_admin" on storage.objects;
create policy "documents_bucket_delete_admin"
on storage.objects for delete using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'admin'
      and position(m.workspace_id::text in name) = 1
  )
);
