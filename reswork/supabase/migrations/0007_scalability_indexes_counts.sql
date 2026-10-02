-- 0007: scalability indexes + set-based count RPCs (Tasks D/E/H).
--
-- Every index below names the query it accelerates and why no existing
-- index covers it. All are plain btree lookups on high-selectivity
-- workspace/project/tag/collection scoping columns — cheap to write
-- (single-column, narrow), large read savings once libraries grow past a
-- few hundred rows. No index is added "because a column exists": each maps
-- to an observed application query pattern (see callers in comments).
--
-- The three count RPCs replace N+1 per-row `select count(head:true)` loops
-- in listCollections / listTags / listProjects (1+N queries -> 2 queries
-- total: the listing + one GROUP BY). They follow the existing 0001 RPC
-- pattern: SECURITY DEFINER + public.is_workspace_member(ws_id) guard, so
-- callers get counts only for workspaces they belong to. RLS stays enabled;
-- these functions run with the same least-privilege shape as
-- fts_search_chunks / vector_search_chunks.

-- 1. document_tags(tag_id) ---------------------------------------------------
-- Accelerates: listDocuments tag prefilter
--   (.from("document_tags").select("document_id").eq("tag_id", …)) and
--   tag_doc_counts below. Cardinality: one row per (document, tag); tag
--   fan-in is unbounded (every doc in the workspace can share a tag).
-- Existing PK (document_id, tag_id) serves only the document -> tags
-- direction, not tag -> documents.
create index if not exists idx_document_tags_tag
  on public.document_tags(tag_id);

-- 2. document_collections(collection_id) --------------------------------------
-- Accelerates: listDocuments collection prefilter + collection_doc_counts.
-- Same asymmetry as (1): PK (document_id, collection_id) does not cover
-- collection -> documents.
create index if not exists idx_document_collections_collection
  on public.document_collections(collection_id);

-- 3. document_authors(author_id) ----------------------------------------------
-- Accelerates: relatedDocuments shared-author traversal
--   (.from("document_authors").in("author_id", …).limit(100)).
-- Existing PK (document_id, author_id) serves only document -> authors.
create index if not exists idx_document_authors_author
  on public.document_authors(author_id);

-- 4. claims(project_id) --------------------------------------------------------
-- Accelerates: projectClaims (.from("claims").eq("project_id", …)).
-- Existing idx_claims_ws covers workspace scoping only, not the
-- per-project claim list the UI renders.
create index if not exists idx_claims_project
  on public.claims(project_id);

-- 5. evidence_items(project_id) -------------------------------------------------
-- Accelerates: getProject evidence leg
--   (.from("evidence_items").eq("project_id", …)). No index existed at all.
create index if not exists idx_evidence_project
  on public.evidence_items(project_id);

-- 6. research_queries(project_id, created_at desc) -------------------------------
-- Accelerates: getProject queries leg
--   (.eq("project_id", …).order("created_at", desc).limit(50)).
-- Composite serves filter + ordering in one pass; no index existed at all.
create index if not exists idx_research_queries_project_created
  on public.research_queries(project_id, created_at desc);

-- 7. source_citations(source_id) --------------------------------------------------
-- Accelerates: citedCases / legalRefresh / relatedDocuments edge reads
--   (.from("source_citations").eq("source_id", …)).
-- Existing indexes cover (workspace_id) and (cited_identifier) only.
create index if not exists idx_source_citations_source
  on public.source_citations(source_id);

-- 8. saved_searches(workspace_id) ---------------------------------------------------
-- Accelerates: listSavedSearches (.eq("workspace_id", …).order(created_at)).
-- Small table, but it had no index at all — every load was a sequential scan.
create index if not exists idx_saved_searches_ws
  on public.saved_searches(workspace_id);

-- 9. documents(workspace_id, created_at desc) -----------------------------------------
-- Accelerates: listDocuments hot path
--   (.eq("workspace_id", ws).order("created_at", desc).limit(200)).
-- Existing idx_documents_ws covers the filter but not the ordering: without
-- the composite, every library open sorts the workspace's full document set.
create index if not exists idx_documents_ws_created
  on public.documents(workspace_id, created_at desc);

-- 10. document_chunks(workspace_id) ------------------------------------------------------
-- Accelerates: chunkCount (.eq("workspace_id", ws), head count) and any
-- workspace-scoped chunk maintenance. Existing idx_chunks_doc covers only
-- the per-document direction.
create index if not exists idx_chunks_ws
  on public.document_chunks(workspace_id);

-- Set-based count RPCs (replace N+1 loops) ----------------------------------------------
--
-- Each returns (id, document_count) for non-empty buckets only; callers left-
-- join against their listing with a 0 default, so behavior for empty
-- collections/tags/projects is unchanged. Membership guard fails closed:
-- non-members get zero rows (the UI then shows 0, never another
-- workspace's counts).

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
