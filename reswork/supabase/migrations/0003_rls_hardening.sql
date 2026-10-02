-- 0003: RLS hardening (audit fixes).
--
-- 1. chat_messages SELECT ignored chat visibility: any workspace member could
--    read messages of PRIVATE chats if they learned the chat id. Now mirrors
--    the chats-table rule (workspace-visible, or owner, or admin).
-- 2. document_chunks / document_embeddings SELECT ignored document approval:
--    any member could read chunks of PENDING (unapproved) documents, bypassing
--    the upload-approval flow. Now scoped to approved docs (+ own pending +
--    admin), matching the documents-table rule.
-- 3. document_embeddings had a SELECT-only policy, which silently blocked ALL
--    member embedding INSERTs (uploads landed with ingestion errors). Add
--    proper write policies gated through the parent chunk's workspace.

-- 1. Private-chat message visibility -------------------------------------------
drop policy if exists "chat_messages_read_ws" on public.chat_messages;
create policy "chat_messages_read_ws" on public.chat_messages for select using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and public.is_workspace_member(c.workspace_id)
            and (c.visibility = 'workspace'
                 or c.owner_id = auth.uid()
                 or public.is_workspace_admin(c.workspace_id)))
);

-- 2. Chunk / embedding reads respect document approval --------------------------
drop policy if exists "shared_read" on public.document_chunks;
create policy "chunks_read" on public.document_chunks for select using (
  public.is_workspace_member(workspace_id)
  and exists (select 1 from public.documents d
              where d.id = document_chunks.document_id
                and (d.status = 'approved'
                     or d.uploaded_by = auth.uid()
                     or public.is_workspace_admin(d.workspace_id)))
);

drop policy if exists "shared_member_write" on public.document_embeddings;
create policy "embeddings_read" on public.document_embeddings for select using (
  exists (select 1 from public.document_chunks c
          join public.documents d on d.id = c.document_id
          where c.id = document_embeddings.chunk_id
            and public.is_workspace_member(c.workspace_id)
            and (d.status = 'approved'
                 or d.uploaded_by = auth.uid()
                 or public.is_workspace_admin(d.workspace_id)))
);

-- 3. Embedding writes (were SELECT-only: member uploads failed indexing) --------
create policy "embeddings_insert" on public.document_embeddings
  for insert with check (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_member(c.workspace_id))
  );

create policy "embeddings_update" on public.document_embeddings
  for update using (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_member(c.workspace_id))
  ) with check (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_member(c.workspace_id))
  );

create policy "embeddings_delete" on public.document_embeddings
  for delete using (
    exists (select 1 from public.document_chunks c
            join public.documents d on d.id = c.document_id
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_admin(d.workspace_id))
  );
