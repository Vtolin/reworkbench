-- 0014: search scalability (Phase 5).
--
-- A. Trigram + scoping indexes for every ilike site. The authors /
--    collections / tags tables had NO indexes at all: each name resolution
--    (workspace-scoped ilike, used by grouped search + taxonomy) seq-scanned.
--    pg_trgm is already enabled (0001). GIN trigram serves the ilike leg;
--    btree on workspace_id serves the scoping leg; the planner combines them
--    with a bitmap AND. documents.title gets the trigram leg next to the
--    existing idx_documents_ws scoping index.
-- B. Missing scoping indexes: annotations(workspace_id) (only document_id
--    was indexed), research_trail(project_id) (only the workspace+created
--    composite existed), claims(workspace_id, project_id) composite (the two
--    single-column indexes from 0001/0007 serve one direction each).
-- C. Denormalized document_embeddings.workspace_id (staged safely):
--    1. ADD COLUMN nullable (no table rewrite blocks writers beyond a brief
--       lock; embeddings inserts continue with NULL).
--    2. Row trigger stamps new rows from their chunk (so post-migration
--       writes are always stamped, even mid-backfill).
--    3. Backfill from document_chunks.
--    4. SET NOT NULL (fails safe — whole migration rolls back — if any NULL
--       slipped through, e.g. an insert racing between 1 and 2 on a
--       predating build; re-running the migration converges).
--    5. btree index + vector RPC filters on it (no more join-through-chunks
--       for scoping; joins remain for content/status).
-- D. RPC hardening for both retrieval legs: match_count clamped in SQL
--    (1..50, so a crafted topN can never widen the scan), the query parsed to
--    tsquery ONCE in a CTE (was: websearch_to_tsquery evaluated per row in
--    both SELECT and WHERE), and a 10s statement_timeout function attribute.
--
-- Rollback: drop index <each name below>; drop trigger trg_embeddings_ws on
--   public.document_embeddings; drop function
--   public.stamp_embedding_workspace(); alter table
--   public.document_embeddings drop column workspace_id; the RPC bodies revert
--   to 0001 (re-apply the replaced definitions).
-- RLS: unchanged (no policies touched). New column inherits table RLS.

-- A. taxonomy scoping (existing queries, previously unindexed) -------------
create index if not exists idx_authors_ws on public.authors(workspace_id);
create index if not exists idx_collections_ws on public.collections(workspace_id);
create index if not exists idx_tags_ws on public.tags(workspace_id);

-- A. trigram legs for ilike sites -------------------------------------------
create index if not exists idx_authors_name_trgm on public.authors using gin (name gin_trgm_ops);
create index if not exists idx_collections_name_trgm on public.collections using gin (name gin_trgm_ops);
create index if not exists idx_tags_name_trgm on public.tags using gin (name gin_trgm_ops);
create index if not exists idx_documents_title_trgm on public.documents using gin (title gin_trgm_ops);

-- B. missing scoping indexes --------------------------------------------------
create index if not exists idx_annotations_ws on public.annotations(workspace_id);
create index if not exists idx_trail_project on public.research_trail(project_id);
create index if not exists idx_claims_ws_project on public.claims(workspace_id, project_id);

-- C. denormalized embeddings workspace_id (staged) ---------------------------
alter table public.document_embeddings
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

create or replace function public.stamp_embedding_workspace()
returns trigger language plpgsql set search_path = public as $$
begin
  select c.workspace_id into new.workspace_id
  from public.document_chunks c
  where c.id = new.chunk_id;
  return new;
end $$;

drop trigger if exists trg_embeddings_ws on public.document_embeddings;
create trigger trg_embeddings_ws
  before insert on public.document_embeddings
  for each row execute function public.stamp_embedding_workspace();

update public.document_embeddings e
set workspace_id = c.workspace_id
from public.document_chunks c
where c.id = e.chunk_id
  and e.workspace_id is null;

alter table public.document_embeddings
  alter column workspace_id set not null;

create index if not exists idx_embeddings_ws on public.document_embeddings(workspace_id);

-- D. hardened retrieval RPCs --------------------------------------------------
create or replace function public.fts_search_chunks(
  ws_id uuid, q text, match_count int default 20
)
returns table (
  chunk_id uuid, document_id uuid, content text, chunk_index int,
  page int, section text, rank float
)
language sql stable security definer
set search_path = public
set statement_timeout = '10s' as $$
  with parsed as (
    select websearch_to_tsquery('english', q) as ts
  )
  select c.id, c.document_id, c.content, c.chunk_index, c.page, c.section,
         ts_rank_cd(c.fts, parsed.ts)::float as rank
  from public.document_chunks c
  cross join parsed
  join public.documents d on d.id = c.document_id
  where c.workspace_id = ws_id
    and d.status = 'approved'
    and c.fts @@ parsed.ts
    and public.is_workspace_member(ws_id)
  order by rank desc
  limit least(greatest(match_count, 1), 50);
$$;

create or replace function public.vector_search_chunks(
  ws_id uuid, query_embedding vector(768), match_count int default 20
)
returns table (
  chunk_id uuid, document_id uuid, content text, chunk_index int,
  page int, section text, distance float
)
language sql stable security definer
set search_path = public
set statement_timeout = '10s' as $$
  select c.id, c.document_id, c.content, c.chunk_index, c.page, c.section,
         (e.embedding <=> query_embedding)::float as distance
  from public.document_embeddings e
  join public.document_chunks c on c.id = e.chunk_id
  join public.documents d on d.id = c.document_id
  where e.workspace_id = ws_id
    and d.status = 'approved'
    and public.is_workspace_member(ws_id)
  order by e.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;
