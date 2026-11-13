-- Add workspace-level auto_approve_uploads setting (opt-in; default false).
alter table public.workspaces
  add column if not exists auto_approve_uploads boolean not null default false;

create or replace function public.workspace_auto_approve(ws_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select w.auto_approve_uploads from public.workspaces w where w.id = ws_id),
    false
  );
$$;

drop policy if exists "documents_member_insert_pending" on public.documents;
create policy "documents_member_insert_pending" on public.documents for insert with check (
  public.is_workspace_member(workspace_id)
  and uploaded_by = auth.uid()
  and (
    status = 'pending'
    or (status = 'approved' and (public.workspace_auto_approve(workspace_id) or public.is_workspace_admin(workspace_id)))
  )
);
