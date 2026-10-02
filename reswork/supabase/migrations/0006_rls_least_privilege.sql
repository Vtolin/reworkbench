-- 0006: least-privilege splits (Phase 4).
--
-- Only tables whose denied operations have NO application writers are
-- restricted here (caller audit, Phase 4):
--   research_trail   — app only INSERTs (trail route) + SELECTs.
--   research_queries — app only INSERTs (recordQuery) + SELECTs.
--   document_chunks  — app only INSERTs (ingest) + SELECTs; cleanup flows
--                      through documents ON DELETE CASCADE (admin-only).
--   document_embeddings — app only INSERTs (ingest; see 0003 §3) + SELECTs.
-- For these, member UPDATE/DELETE becomes an admin repair path; admins stay
-- trusted and service_role bypasses RLS for emergencies regardless.
--
-- Deliberately UNCHANGED (shared-ownership model, observed behavior):
-- sources, source_citations (legal refresh rewrites any doc's rows),
-- authors, collections, tags + all join tables (shared tagging/curation),
-- research_projects, claims, citations, evidence_items, annotations,
-- saved_searches (workspace-wide curation with no owner gating in the UI).
-- Restricting those needs a product decision + UI gating first; doing it
-- here would turn working buttons into RLS errors.

-- research_trail: append-only for members ---------------------------------
drop policy if exists "shared_member_write" on public.research_trail;
create policy "trail_member_insert" on public.research_trail
  for insert with check (public.is_workspace_member(workspace_id));
create policy "trail_admin_write" on public.research_trail
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "trail_admin_delete" on public.research_trail
  for delete using (public.is_workspace_admin(workspace_id));

-- research_queries: history is never edited --------------------------------
drop policy if exists "shared_member_write" on public.research_queries;
create policy "queries_member_insert" on public.research_queries
  for insert with check (public.is_workspace_member(workspace_id));
create policy "queries_admin_write" on public.research_queries
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "queries_admin_delete" on public.research_queries
  for delete using (public.is_workspace_admin(workspace_id));

-- document_chunks: ingest inserts; repair is admin-only --------------------
-- (SELECT stays chunks_read from 0003.)
drop policy if exists "shared_member_write" on public.document_chunks;
create policy "chunks_member_insert" on public.document_chunks
  for insert with check (public.is_workspace_member(workspace_id));
create policy "chunks_admin_write" on public.document_chunks
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "chunks_admin_delete" on public.document_chunks
  for delete using (public.is_workspace_admin(workspace_id));

-- document_embeddings: keep member INSERT (ingest needs it, see 0003 §3);
-- narrow member UPDATE to admin (no application writer exists).
-- (embeddings_insert / embeddings_delete / embeddings_read stay as-is.)
drop policy if exists "embeddings_update" on public.document_embeddings;
create policy "embeddings_admin_update" on public.document_embeddings
  for update using (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_admin(c.workspace_id))
  ) with check (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_admin(c.workspace_id))
  );

-- Storage: match the first path segment exactly instead of a string prefix.
-- Legitimate paths are always "<workspace_id>/<sha>.<ext>" (ingest builds
-- them as `${ws}/${fileHash}.${ext}`), so behavior is unchanged; an id
-- that merely shares a string prefix no longer matches.
drop policy if exists "documents_bucket_read_members" on storage.objects;
create policy "documents_bucket_read_members"
on storage.objects for select using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and (storage.foldername(name))[1] = m.workspace_id::text
  )
);

drop policy if exists "documents_bucket_insert_members" on storage.objects;
create policy "documents_bucket_insert_members"
on storage.objects for insert with check (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and (storage.foldername(name))[1] = m.workspace_id::text
  )
);

drop policy if exists "documents_bucket_delete_admin" on storage.objects;
create policy "documents_bucket_delete_admin"
on storage.objects for delete using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.workspace_members m
    where m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'admin'
      and (storage.foldername(name))[1] = m.workspace_id::text
  )
);
