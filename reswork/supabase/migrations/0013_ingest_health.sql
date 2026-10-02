-- 0013: ingest-health RPC (Phase 4: ingest resilience).
--
-- One row per document needing attention: ingestion_status = 'error' (even
-- with zero chunks — chunk-insert failure, re-upload required) or chunks
-- missing embeddings (FTS-only when embedded = 0, partial otherwise). The
-- Admin queue and the idempotent re-embed path read this instead of N+1
-- per-document queries; it is admin-triggered, never polled.
--
-- Rollback: drop function public.ingest_health(uuid);
-- RLS: unchanged (no policies touched). Membership guard inside, following
-- the 0007 count-RPC pattern, so any workspace member may call it.
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
