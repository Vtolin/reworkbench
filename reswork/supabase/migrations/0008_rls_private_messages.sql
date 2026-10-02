-- 0008: private chat messages are actually private (Task B finding).
--
-- Hole: chat_messages_read_ws gated on workspace membership ALONE, so any
-- member holding a chat_id (realtime payload, stale import link, UUID spray)
-- could SELECT messages of PRIVATE chats — including Stored chats, which the
-- application documents as owner-only account backups
-- (lib/wb/publish.ts: "visibility 'private' so only the owner reads it").
-- The chats table itself hid the private chat ROW (chats_read_ws checks
-- visibility), but the messages were one direct query away.
--
-- Fix: mirror chats_read_ws on the message policy — workspace-visible, owner,
-- or admin. Caller audit (no application reader breaks):
--   gallery/import (fetchSharedChat, listSharedChats) — workspace visibility
--     chats only: allowed.
--   stored backup/sync (listStoredChats, upload/push/delete flows) — owner
--     reads/writes own chats: allowed.
--   admin repair/audit — explicit admin override preserved (matches
--     chats_owner_delete / chat_messages_owner_delete, which already admit
--     admins).
--   fetchSharedChat on a private chat by a non-owner keeps failing closed
--     at the chats-row read ("Shared chat not found"), as before.
-- Verified by the staging probe (src/security/rls-probe.test.ts,
-- "private chat messages are visible to the owner but not to a workspace
-- member"), which FAILS on 0001–0007 and passes with this migration.
drop policy if exists "chat_messages_read_ws" on public.chat_messages;
create policy "chat_messages_read_ws" on public.chat_messages for select using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and public.is_workspace_member(c.workspace_id)
            and (c.visibility = 'workspace'
                 or c.owner_id = auth.uid()
                 or public.is_workspace_admin(c.workspace_id)))
);
