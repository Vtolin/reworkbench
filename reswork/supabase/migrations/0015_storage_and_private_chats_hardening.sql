-- 0015: Storage folder segment hardening and private chat privacy fix.
--
-- 1. Storage: Re-enforces exact folder segment matching from 0006 while retaining
--    the 50MB upload size limit from 0012 (fixes SEC-04 regression).
-- 2. Chat Privacy: Ensures private chats and their messages are strictly accessible
--    only by their owner (fixes SEC-06).

-- 1. Hardened Storage Insert Policy ------------------------------------------
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
      and (storage.foldername(name))[1] = m.workspace_id::text
  )
);

-- 2. Private Chat RLS Hardening -----------------------------------------------
drop policy if exists "chats_read_ws" on public.chats;
create policy "chats_read_ws" on public.chats for select using (
  public.is_workspace_member(workspace_id)
  and (visibility = 'workspace' or owner_id = auth.uid())
);

drop policy if exists "chat_messages_read_ws" on public.chat_messages;
create policy "chat_messages_read_ws" on public.chat_messages for select using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and public.is_workspace_member(c.workspace_id)
            and (c.visibility = 'workspace' or c.owner_id = auth.uid()))
);
