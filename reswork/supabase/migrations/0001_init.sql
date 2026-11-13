-- Research Workbench — unified cloud schema (compacted from 0001–0015 + seed).
-- Supabase owns the collaborative research state. Browser owns the AI connection.
-- No FastAPI, no SQLite, no Chroma, no local filesystem as source of truth.
-- Safe to re-run (idempotent): uses IF NOT EXISTS, OR REPLACE, and DROP IF EXISTS.

-- Extensions ------------------------------------------------------------------
create extension if not exists "pgcrypto";
create extension if not exists "vector"; -- pgvector: extension name is "vector", not "pgvector"
create extension if not exists "pg_trgm";

-- Profiles --------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- Workspaces ------------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_id uuid references auth.users(id) on delete set null,
  member_limit int not null default 10 check (member_limit >= 1 and member_limit <= 10),
  auto_approve_uploads boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'active' check (status in ('active','removed')),
  joined_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists idx_workspace_members_ws on public.workspace_members(workspace_id);
create index if not exists idx_workspace_members_user on public.workspace_members(user_id);

-- Helper: is caller an active member of a workspace? (SECURITY DEFINER to
-- avoid RLS recursion when policies on workspace_members query themselves.)
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_workspace_admin(ws_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'admin'
  );
$$;

-- Returns the caller's (first) active workspace id, or NULL.
create or replace function public.my_workspace_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = auth.uid() and m.status = 'active'
  order by m.joined_at asc limit 1;
$$;

-- Atomic workspace self-join with DB-enforced member limit.
-- Serializes joins per workspace via pg_advisory_xact_lock, then recounts
-- and inserts in the same transaction so concurrent requests cannot overshoot.
create or replace function public.join_workspace(
  p_workspace_id uuid, p_user_id uuid, p_limit int
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  existing_status text;
  current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text));
  select status into existing_status
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id
  order by joined_at desc nulls last
  limit 1;
  if existing_status is not null and existing_status <> 'active' then
    return 'revoked';
  end if;
  if existing_status = 'active' then
    return 'already';
  end if;
  select count(*) into current_count
  from public.workspace_members
  where workspace_id = p_workspace_id and status = 'active';
  if current_count >= p_limit then
    return 'full';
  end if;
  insert into public.workspace_members(workspace_id, user_id, role, status)
  values (p_workspace_id, p_user_id, 'member', 'active');
  return 'ok';
end $$;

revoke all on function public.join_workspace(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.join_workspace(uuid, uuid, int) to service_role;

-- Library ---------------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null default '',
  original_filename text not null default '',
  storage_path text,                       -- Supabase Storage path (documents bucket)
  file_hash text,                          -- SHA-256 hex
  file_size bigint,
  mime_type text,
  doi text,
  year int,
  journal text,
  volume text,
  issue text,
  pages text,
  publisher text,
  abstract text,
  jurisdiction text,
  document_type text,                      -- legal|empirical|survey|thesis|general
  page_count int,
  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending','ready','metadata_only','error')),
  ingestion_error text,
  metadata_json jsonb not null default '{}',
  citation_metadata jsonb not null default '{}',
  metadata_source text,
  metadata_fetched_at timestamptz,
  metadata_confidence double precision,
  metadata_verified boolean not null default false,
  status text not null default 'pending'   -- upload -> approval flow
    check (status in ('pending','approved','rejected')),
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(abstract,'')), 'B')
  ) stored
);
create index if not exists idx_documents_ws on public.documents(workspace_id);
create index if not exists idx_documents_ws_created on public.documents(workspace_id, created_at desc);
create index if not exists idx_documents_hash on public.documents(file_hash);
create index if not exists idx_documents_doi on public.documents(doi);
create index if not exists idx_documents_year on public.documents(year);
create index if not exists idx_documents_status on public.documents(status);
create index if not exists idx_documents_fts on public.documents using gin (fts);
create index if not exists idx_documents_title_trgm on public.documents using gin (title gin_trgm_ops);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  source_type text not null default 'journal',
  doi text,
  title text,
  journal text,
  volume text,
  issue text,
  pages text,
  publisher text,
  year int,
  authors_json jsonb not null default '[]',
  venue text,
  court text,
  case_number text,
  decision_date date,
  parties_json jsonb not null default '[]',
  judges_json jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sources_ws on public.sources(workspace_id);
create index if not exists idx_sources_doc on public.sources(document_id);
create index if not exists idx_sources_doi on public.sources(doi);
create index if not exists idx_sources_case_number on public.sources(case_number);

create table if not exists public.source_citations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  cited_identifier text not null,
  cited_source_id uuid references public.sources(id) on delete set null,
  kind text not null default 'case' check (kind in ('case','statute','article')),
  locator text,
  created_at timestamptz not null default now()
);
create index if not exists idx_source_citations_ws on public.source_citations(workspace_id);
create index if not exists idx_source_citations_source on public.source_citations(source_id);
create index if not exists idx_source_citations_identifier on public.source_citations(cited_identifier);

create table if not exists public.authors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  unique (workspace_id, name)
);
create index if not exists idx_authors_ws on public.authors(workspace_id);
create index if not exists idx_authors_name_trgm on public.authors using gin (name gin_trgm_ops);

create table if not exists public.document_authors (
  document_id uuid not null references public.documents(id) on delete cascade,
  author_id uuid not null references public.authors(id) on delete cascade,
  author_order int not null default 0,
  primary key (document_id, author_id)
);
create index if not exists idx_document_authors_author on public.document_authors(author_id);

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  color text not null default '#6366f1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists idx_collections_ws on public.collections(workspace_id);
create index if not exists idx_collections_name_trgm on public.collections using gin (name gin_trgm_ops);

create table if not exists public.document_collections (
  document_id uuid not null references public.documents(id) on delete cascade,
  collection_id uuid not null references public.collections(id) on delete cascade,
  primary key (document_id, collection_id)
);
create index if not exists idx_document_collections_collection on public.document_collections(collection_id);

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  color text not null default '#8b5cf6',
  unique (workspace_id, name)
);
create index if not exists idx_tags_ws on public.tags(workspace_id);
create index if not exists idx_tags_name_trgm on public.tags using gin (name gin_trgm_ops);

create table if not exists public.document_tags (
  document_id uuid not null references public.documents(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (document_id, tag_id)
);
create index if not exists idx_document_tags_tag on public.document_tags(tag_id);

-- Research --------------------------------------------------------------------
create table if not exists public.research_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_research_projects_ws on public.research_projects(workspace_id);

create table if not exists public.research_project_documents (
  project_id uuid not null references public.research_projects(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  primary key (project_id, document_id)
);

create table if not exists public.research_queries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.research_projects(id) on delete set null,
  query text not null,
  answer text,
  retrieval_mode text,
  model_used text,
  sources_json jsonb not null default '[]',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_research_queries_project_created on public.research_queries(project_id, created_at desc);

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.research_projects(id) on delete cascade,
  text text not null,
  status text not null default 'open' check (status in ('open','supported','disputed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_claims_ws on public.claims(workspace_id);
create index if not exists idx_claims_project on public.claims(project_id);
create index if not exists idx_claims_ws_project on public.claims(workspace_id, project_id);

create table if not exists public.citations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid references public.sources(id) on delete cascade,
  claim_id uuid references public.claims(id) on delete cascade,
  support text not null default 'supports'
    check (support in ('supports','contradicts','mentions')),
  locator text,
  created_at timestamptz not null default now()
);
create index if not exists idx_citations_claim on public.citations(claim_id);

create table if not exists public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.research_projects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  claim text,
  quoted_evidence text,
  page int,
  location text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_evidence_project on public.evidence_items(project_id);

create table if not exists public.annotations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  page int not null default 1,
  start_offset int,
  end_offset int,
  selected_text text,
  note text,
  color text not null default '#facc15',
  category text not null default 'highlight',
  tags_json jsonb not null default '[]',
  project_id uuid references public.research_projects(id) on delete set null,
  claim_id uuid references public.claims(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_annotations_doc on public.annotations(document_id);
create index if not exists idx_annotations_ws on public.annotations(workspace_id);

create table if not exists public.research_trail (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.research_projects(id) on delete set null,
  event_type text not null,
  payload_json jsonb not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_trail_ws on public.research_trail(workspace_id, created_at desc);
create index if not exists idx_trail_project on public.research_trail(project_id);

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  query text not null,
  filters_json jsonb not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_saved_searches_ws on public.saved_searches(workspace_id);

-- Set-based count RPCs (replace N+1 listing count queries) -----------------
create or replace function public.collection_doc_counts(ws_id uuid)
returns table (collection_id uuid, document_count bigint)
language sql stable security definer set search_path = public as $$
  select dc.collection_id, count(*)::bigint
  from public.document_collections dc
  join public.collections c on c.id = dc.collection_id
  where c.workspace_id = ws_id
    and public.is_workspace_member(ws_id)
  group by dc.collection_id;
$$;

create or replace function public.tag_doc_counts(ws_id uuid)
returns table (tag_id uuid, document_count bigint)
language sql stable security definer set search_path = public as $$
  select dt.tag_id, count(*)::bigint
  from public.document_tags dt
  join public.tags t on t.id = dt.tag_id
  where t.workspace_id = ws_id
    and public.is_workspace_member(ws_id)
  group by dt.tag_id;
$$;

create or replace function public.project_doc_counts(ws_id uuid)
returns table (project_id uuid, document_count bigint)
language sql stable security definer set search_path = public as $$
  select rpd.project_id, count(*)::bigint
  from public.research_project_documents rpd
  join public.research_projects p on p.id = rpd.project_id
  where p.workspace_id = ws_id
    and public.is_workspace_member(ws_id)
  group by rpd.project_id;
$$;

-- RAG: chunks + embeddings ----------------------------------------------------
-- NOTE: embedding dimensionality 768 matches `nomic-embed-text` (and truncated
-- OpenAI/Google 768d embeddings).
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  content text not null,
  chunk_index int not null default 0,
  page int,
  section text,
  pinpoint text,
  created_at timestamptz not null default now(),
  fts tsvector generated always as (to_tsvector('english', coalesce(content,''))) stored
);
create index if not exists idx_chunks_doc on public.document_chunks(document_id);
create index if not exists idx_chunks_ws on public.document_chunks(workspace_id);
create index if not exists idx_chunks_fts on public.document_chunks using gin (fts);

create table if not exists public.document_embeddings (
  id uuid primary key default gen_random_uuid(),
  chunk_id uuid not null references public.document_chunks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  embedding vector(768) not null,
  model_name text not null default 'nomic-embed-text',
  created_at timestamptz not null default now()
);
create index if not exists idx_embeddings_chunk on public.document_embeddings(chunk_id);
create index if not exists idx_embeddings_ws on public.document_embeddings(workspace_id);
create index if not exists idx_embeddings_hnsw
  on public.document_embeddings using hnsw (embedding vector_cosine_ops);

-- Trigger stamps workspace_id from parent chunk so browser inserts need not supply it.
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

-- Ingest health RPC (admin queue / re-embed targets)
create or replace function public.ingest_health(ws_id uuid)
returns table (
  document_id uuid, title text, ingestion_status text, ingestion_error text,
  chunks bigint, embedded bigint
)
language sql stable security definer set search_path = public as $$
  select d.id, d.title, d.ingestion_status, d.ingestion_error,
         count(distinct c.id)::bigint, count(distinct e.chunk_id)::bigint
  from public.documents d
  left join public.document_chunks c on c.document_id = d.id
  left join public.document_embeddings e on e.chunk_id = c.id
  where d.workspace_id = ws_id
    and public.is_workspace_member(ws_id)
  group by d.id
  having (d.ingestion_status = 'error')
      or (count(distinct e.chunk_id) < count(distinct c.id));
$$;

-- Hybrid retrieval RPC: FTS leg (single tsquery parse, bounded limit, 10s timeout)
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

-- Hybrid retrieval RPC: vector leg (filters on e.workspace_id, bounded limit, 10s timeout)
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

-- Chat & Deletion Requests ----------------------------------------------------
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled chat',
  visibility text not null default 'workspace'
    check (visibility in ('workspace','private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_chats_ws on public.chats(workspace_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  metadata_json jsonb not null default '{}',  -- e.g. {"provider":"ollama","model":"gemma4:26b"}
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_chat on public.chat_messages(chat_id, created_at);

create table if not exists public.chat_imports (
  id uuid primary key default gen_random_uuid(),
  source_chat_id uuid not null references public.chats(id) on delete cascade,
  target_chat_id uuid not null references public.chats(id) on delete cascade,
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

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

-- Personal cloud-AI credentials (BYOK) ----------------------------------------
-- Encrypted at rest server-side (src/lib/ai/keys.ts). One row per (user_id, provider).
create table if not exists public.ai_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,                  -- openai|anthropic|google|deepseek|...
  ciphertext text not null,                -- AES-GCM encrypted API key
  iv text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- Postgres-backed fixed-window rate limiting ----------------------------------
-- Deny-all RLS (no policies); reachable only via service_role / SECURITY DEFINER RPC.
create table if not exists public.rate_limit_buckets (
  scope text not null,
  subject text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (scope, subject, window_start)
);

create or replace function public.check_rate_limit(
  p_scope text, p_subject text, p_limit int, p_window_secs int
)
returns table (allowed boolean, count integer, retry_after_secs integer)
language plpgsql security definer set search_path = public as $$
declare
  ws timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  current_count integer;
begin
  delete from public.rate_limit_buckets
  where scope = p_scope and subject = p_subject and window_start < ws;
  insert into public.rate_limit_buckets(scope, subject, window_start, count)
  values (p_scope, p_subject, ws, 1)
  on conflict (scope, subject, window_start)
  do update set count = rate_limit_buckets.count + 1
  returning rate_limit_buckets.count into current_count;
  if current_count <= p_limit then
    return query select true, current_count, 0;
  else
    return query select
      false,
      current_count,
      (extract(epoch from (ws + make_interval(secs => p_window_secs) - now()))::integer);
  end if;
end $$;

revoke all on function public.check_rate_limit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, text, int, int) to service_role;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;

-- Updated-at triggers ---------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_documents_touch on public.documents;
create trigger trg_documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_chats_touch on public.chats;
create trigger trg_chats_touch before update on public.chats
  for each row execute function public.touch_updated_at();

-- Row Level Security ----------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.documents enable row level security;
alter table public.sources enable row level security;
alter table public.source_citations enable row level security;
alter table public.authors enable row level security;
alter table public.document_authors enable row level security;
alter table public.collections enable row level security;
alter table public.document_collections enable row level security;
alter table public.tags enable row level security;
alter table public.document_tags enable row level security;
alter table public.research_projects enable row level security;
alter table public.research_project_documents enable row level security;
alter table public.research_queries enable row level security;
alter table public.claims enable row level security;
alter table public.citations enable row level security;
alter table public.evidence_items enable row level security;
alter table public.annotations enable row level security;
alter table public.research_trail enable row level security;
alter table public.saved_searches enable row level security;
alter table public.document_chunks enable row level security;
alter table public.document_embeddings enable row level security;
alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_imports enable row level security;
alter table public.chat_deletion_requests enable row level security;
alter table public.ai_credentials enable row level security;
alter table public.rate_limit_buckets enable row level security;

-- profiles: readable by workspace co-members, writable by owner
drop policy if exists "profiles_read_members" on public.profiles;
create policy "profiles_read_members" on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from public.workspace_members m1
    join public.workspace_members m2 on m1.workspace_id = m2.workspace_id
    where m1.user_id = auth.uid() and m1.status = 'active'
      and m2.user_id = profiles.id and m2.status = 'active'
  )
);
drop policy if exists "profiles_write_own" on public.profiles;
create policy "profiles_write_own" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- workspaces: visible to active members; updates by admin
drop policy if exists "workspaces_read_members" on public.workspaces;
create policy "workspaces_read_members" on public.workspaces for select using (
  public.is_workspace_member(id)
);
drop policy if exists "workspaces_update_admin" on public.workspaces;
create policy "workspaces_update_admin" on public.workspaces for update using (
  public.is_workspace_admin(id)
) with check (
  public.is_workspace_admin(id)
);

-- workspace_members: visible to members of that workspace; admin manages
drop policy if exists "members_read_ws" on public.workspace_members;
create policy "members_read_ws" on public.workspace_members for select using (
  public.is_workspace_member(workspace_id)
);
drop policy if exists "members_admin_write" on public.workspace_members;
create policy "members_admin_write" on public.workspace_members
  for all using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- documents: members read approved + own pending; insert pending only; admin approves/deletes
drop policy if exists "documents_read" on public.documents;
create policy "documents_read" on public.documents for select using (
  public.is_workspace_member(workspace_id)
  and (
    status = 'approved'
    or uploaded_by = auth.uid()
    or public.is_workspace_admin(workspace_id)
  )
);
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
drop policy if exists "documents_update" on public.documents;
create policy "documents_update" on public.documents for update using (
  public.is_workspace_admin(workspace_id)
  or (uploaded_by = auth.uid() and status = 'pending')
) with check (
  public.is_workspace_admin(workspace_id)
  or (status = 'pending' and uploaded_by = auth.uid())
);
drop policy if exists "documents_admin_delete" on public.documents;
create policy "documents_admin_delete" on public.documents for delete using (
  public.is_workspace_admin(workspace_id)
);

-- Shared workspace curation tables: active members read + write
drop policy if exists "shared_read" on public.sources;
create policy "shared_read" on public.sources for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.sources;
create policy "shared_member_write" on public.sources
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.source_citations;
create policy "shared_read" on public.source_citations for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.source_citations;
create policy "shared_member_write" on public.source_citations
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.authors;
create policy "shared_read" on public.authors for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.authors;
create policy "shared_member_write" on public.authors
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.collections;
create policy "shared_read" on public.collections for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.collections;
create policy "shared_member_write" on public.collections
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.tags;
create policy "shared_read" on public.tags for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.tags;
create policy "shared_member_write" on public.tags
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.research_projects;
create policy "shared_read" on public.research_projects for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.research_projects;
create policy "shared_member_write" on public.research_projects
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.claims;
create policy "shared_read" on public.claims for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.claims;
create policy "shared_member_write" on public.claims
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.citations;
create policy "shared_read" on public.citations for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.citations;
create policy "shared_member_write" on public.citations
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.evidence_items;
create policy "shared_read" on public.evidence_items for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.evidence_items;
create policy "shared_member_write" on public.evidence_items
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.annotations;
create policy "shared_read" on public.annotations for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.annotations;
create policy "shared_member_write" on public.annotations
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "shared_read" on public.saved_searches;
create policy "shared_read" on public.saved_searches for select using (public.is_workspace_member(workspace_id));
drop policy if exists "shared_member_write" on public.saved_searches;
create policy "shared_member_write" on public.saved_searches
  for all using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Least-privilege tables: append-only for members, update/delete admin-only
drop policy if exists "shared_member_write" on public.research_trail;
drop policy if exists "shared_read" on public.research_trail;
create policy "shared_read" on public.research_trail for select using (public.is_workspace_member(workspace_id));
drop policy if exists "trail_member_insert" on public.research_trail;
create policy "trail_member_insert" on public.research_trail
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "trail_admin_write" on public.research_trail;
create policy "trail_admin_write" on public.research_trail
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
drop policy if exists "trail_admin_delete" on public.research_trail;
create policy "trail_admin_delete" on public.research_trail
  for delete using (public.is_workspace_admin(workspace_id));

drop policy if exists "shared_member_write" on public.research_queries;
drop policy if exists "shared_read" on public.research_queries;
create policy "shared_read" on public.research_queries for select using (public.is_workspace_member(workspace_id));
drop policy if exists "queries_member_insert" on public.research_queries;
create policy "queries_member_insert" on public.research_queries
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "queries_admin_write" on public.research_queries;
create policy "queries_admin_write" on public.research_queries
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
drop policy if exists "queries_admin_delete" on public.research_queries;
create policy "queries_admin_delete" on public.research_queries
  for delete using (public.is_workspace_admin(workspace_id));

-- Chunks & embeddings: approval-gated SELECT; member INSERT; admin repair
drop policy if exists "shared_read" on public.document_chunks;
drop policy if exists "shared_member_write" on public.document_chunks;
drop policy if exists "chunks_read" on public.document_chunks;
create policy "chunks_read" on public.document_chunks for select using (
  public.is_workspace_member(workspace_id)
  and exists (select 1 from public.documents d
              where d.id = document_chunks.document_id
                and (d.status = 'approved'
                     or d.uploaded_by = auth.uid()
                     or public.is_workspace_admin(d.workspace_id)))
);
drop policy if exists "chunks_member_insert" on public.document_chunks;
create policy "chunks_member_insert" on public.document_chunks
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists "chunks_admin_write" on public.document_chunks;
create policy "chunks_admin_write" on public.document_chunks
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
drop policy if exists "chunks_admin_delete" on public.document_chunks;
create policy "chunks_admin_delete" on public.document_chunks
  for delete using (public.is_workspace_admin(workspace_id));

drop policy if exists "shared_read" on public.document_embeddings;
drop policy if exists "shared_member_write" on public.document_embeddings;
drop policy if exists "embeddings_update" on public.document_embeddings;
drop policy if exists "embeddings_read" on public.document_embeddings;
create policy "embeddings_read" on public.document_embeddings for select using (
  exists (select 1 from public.document_chunks c
          join public.documents d on d.id = c.document_id
          where c.id = document_embeddings.chunk_id
            and public.is_workspace_member(c.workspace_id)
            and (d.status = 'approved'
                 or d.uploaded_by = auth.uid()
                 or public.is_workspace_admin(d.workspace_id)))
);
drop policy if exists "embeddings_insert" on public.document_embeddings;
create policy "embeddings_insert" on public.document_embeddings
  for insert with check (
    exists (select 1 from public.document_chunks c
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_member(c.workspace_id))
  );
drop policy if exists "embeddings_admin_update" on public.document_embeddings;
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
drop policy if exists "embeddings_delete" on public.document_embeddings;
create policy "embeddings_delete" on public.document_embeddings
  for delete using (
    exists (select 1 from public.document_chunks c
            join public.documents d on d.id = c.document_id
            where c.id = document_embeddings.chunk_id
              and public.is_workspace_admin(d.workspace_id))
  );

-- Join tables: membership resolved through the parent document/project workspace
drop policy if exists "jt_read" on public.document_authors;
create policy "jt_read" on public.document_authors for select using (
  exists (select 1 from public.documents d
          where d.id = document_authors.document_id
            and public.is_workspace_member(d.workspace_id))
);
drop policy if exists "jt_write" on public.document_authors;
create policy "jt_write" on public.document_authors for all using (
  exists (select 1 from public.documents d
          where d.id = document_authors.document_id
            and public.is_workspace_member(d.workspace_id))
) with check (
  exists (select 1 from public.documents d
          where d.id = document_authors.document_id
            and public.is_workspace_member(d.workspace_id))
);

drop policy if exists "jt_read" on public.document_collections;
create policy "jt_read" on public.document_collections for select using (
  exists (select 1 from public.documents d
          where d.id = document_collections.document_id
            and public.is_workspace_member(d.workspace_id))
);
drop policy if exists "jt_write" on public.document_collections;
create policy "jt_write" on public.document_collections for all using (
  exists (select 1 from public.documents d
          where d.id = document_collections.document_id
            and public.is_workspace_member(d.workspace_id))
) with check (
  exists (select 1 from public.documents d
          where d.id = document_collections.document_id
            and public.is_workspace_member(d.workspace_id))
);

drop policy if exists "jt_read" on public.document_tags;
create policy "jt_read" on public.document_tags for select using (
  exists (select 1 from public.documents d
          where d.id = document_tags.document_id
            and public.is_workspace_member(d.workspace_id))
);
drop policy if exists "jt_write" on public.document_tags;
create policy "jt_write" on public.document_tags for all using (
  exists (select 1 from public.documents d
          where d.id = document_tags.document_id
            and public.is_workspace_member(d.workspace_id))
) with check (
  exists (select 1 from public.documents d
          where d.id = document_tags.document_id
            and public.is_workspace_member(d.workspace_id))
);

drop policy if exists "jt_read" on public.research_project_documents;
create policy "jt_read" on public.research_project_documents for select using (
  exists (select 1 from public.research_projects p
          where p.id = research_project_documents.project_id
            and public.is_workspace_member(p.workspace_id))
);
drop policy if exists "jt_write" on public.research_project_documents;
create policy "jt_write" on public.research_project_documents for all using (
  exists (select 1 from public.research_projects p
          where p.id = research_project_documents.project_id
            and public.is_workspace_member(p.workspace_id))
) with check (
  exists (select 1 from public.research_projects p
          where p.id = research_project_documents.project_id
            and public.is_workspace_member(p.workspace_id))
);

-- Chat: workspace-visible readable by members; private chats readable ONLY by owner
drop policy if exists "chats_read_ws" on public.chats;
create policy "chats_read_ws" on public.chats for select using (
  public.is_workspace_member(workspace_id)
  and (visibility = 'workspace' or owner_id = auth.uid())
);
drop policy if exists "chats_owner_insert" on public.chats;
create policy "chats_owner_insert" on public.chats for insert with check (
  owner_id = auth.uid() and public.is_workspace_member(workspace_id)
);
drop policy if exists "chats_owner_update" on public.chats;
create policy "chats_owner_update" on public.chats for update using (
  owner_id = auth.uid()
) with check (owner_id = auth.uid());
drop policy if exists "chats_owner_delete" on public.chats;
create policy "chats_owner_delete" on public.chats for delete using (
  owner_id = auth.uid() or public.is_workspace_admin(workspace_id)
);

drop policy if exists "chat_messages_read_ws" on public.chat_messages;
create policy "chat_messages_read_ws" on public.chat_messages for select using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and public.is_workspace_member(c.workspace_id)
            and (c.visibility = 'workspace' or c.owner_id = auth.uid()))
);
drop policy if exists "chat_messages_owner_write" on public.chat_messages;
create policy "chat_messages_owner_write" on public.chat_messages for insert with check (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and c.owner_id = auth.uid())
);
drop policy if exists "chat_messages_owner_update" on public.chat_messages;
create policy "chat_messages_owner_update" on public.chat_messages for update using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and c.owner_id = auth.uid())
) with check (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and c.owner_id = auth.uid())
);
drop policy if exists "chat_messages_owner_delete" on public.chat_messages;
create policy "chat_messages_owner_delete" on public.chat_messages for delete using (
  exists (select 1 from public.chats c
          where c.id = chat_messages.chat_id
            and (c.owner_id = auth.uid() or public.is_workspace_admin(c.workspace_id)))
);

drop policy if exists "chat_imports_read" on public.chat_imports;
create policy "chat_imports_read" on public.chat_imports for select using (
  exists (select 1 from public.chats c
          where c.id = chat_imports.target_chat_id
            and public.is_workspace_member(c.workspace_id))
);
drop policy if exists "chat_imports_insert" on public.chat_imports;
create policy "chat_imports_insert" on public.chat_imports for insert with check (
  imported_by = auth.uid()
  and exists (select 1 from public.chats t
              where t.id = chat_imports.target_chat_id and t.owner_id = auth.uid())
);

-- Shared-chat deletion requests: owner files (1 pending per chat), admin decides
drop policy if exists "deletion_requests_read" on public.chat_deletion_requests;
create policy "deletion_requests_read" on public.chat_deletion_requests
  for select using (
    public.is_workspace_member(workspace_id)
    and (public.is_workspace_admin(workspace_id) or requested_by = auth.uid())
  );
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
drop policy if exists "deletion_requests_owner_delete" on public.chat_deletion_requests;
create policy "deletion_requests_owner_delete" on public.chat_deletion_requests
  for delete using (
    requested_by = auth.uid() and status = 'pending'
  );
drop policy if exists "deletion_requests_admin_update" on public.chat_deletion_requests;
create policy "deletion_requests_admin_update" on public.chat_deletion_requests
  for update using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

-- ai_credentials: owner-only, always
drop policy if exists "ai_credentials_owner" on public.ai_credentials;
create policy "ai_credentials_owner" on public.ai_credentials
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Storage: `documents` private bucket + folder-segment-scoped RLS + 50MB cap --
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

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

-- Realtime publication (all 8 subscribed tables; idempotent) -----------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'workspace_members',
      'documents',
      'chats',
      'chat_imports',
      'research_projects',
      'research_trail',
      'collections',
      'tags'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
