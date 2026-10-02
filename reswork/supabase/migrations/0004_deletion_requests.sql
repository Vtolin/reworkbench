-- 0004: shared-chat deletion approvals.
--
-- Shared chats are published research artifacts: nobody deletes them
-- unilaterally. The owner files a deletion request; an admin approves
-- (chat row deleted, messages cascade) or rejects. Request rows survive the
-- chat deletion (chat_id SET NULL) as the audit trail.

create table if not exists public.chat_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chat_id uuid references public.chats(id) on delete set null,
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists idx_deletion_requests_ws
  on public.chat_deletion_requests(workspace_id, status);

alter table public.chat_deletion_requests enable row level security;

-- Read: workspace members (admins need to see pending; owners see own).
drop policy if exists "deletion_requests_read" on public.chat_deletion_requests;
create policy "deletion_requests_read" on public.chat_deletion_requests
  for select using (
    public.is_workspace_member(workspace_id)
    and (public.is_workspace_admin(workspace_id) or requested_by = auth.uid())
  );

-- File: chat owners file for their own chats (one pending request per chat).
drop policy if exists "deletion_requests_owner_insert" on public.chat_deletion_requests;
create policy "deletion_requests_owner_insert" on public.chat_deletion_requests
  for insert with check (
    requested_by = auth.uid()
    and status = 'pending'
    and exists (select 1 from public.chats c
                where c.id = chat_deletion_requests.chat_id
                  and c.owner_id = auth.uid()
                  and public.is_workspace_member(c.workspace_id))
    and not exists (select 1 from public.chat_deletion_requests r
                    where r.chat_id = chat_deletion_requests.chat_id
                      and r.status = 'pending')
  );

-- Owner may cancel their own pending request.
drop policy if exists "deletion_requests_owner_delete" on public.chat_deletion_requests;
create policy "deletion_requests_owner_delete" on public.chat_deletion_requests
  for delete using (
    requested_by = auth.uid() and status = 'pending'
  );

-- Admins decide (approve/reject). The actual chat DELETE happens through the
-- existing chats_owner_delete policy (owner or admin).
drop policy if exists "deletion_requests_admin_update" on public.chat_deletion_requests;
create policy "deletion_requests_admin_update" on public.chat_deletion_requests
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
