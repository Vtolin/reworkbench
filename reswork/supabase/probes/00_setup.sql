-- ============================================================================
-- 00_setup.sql — staging runbook + smoke checks (Task A).
-- RUN FIRST, in one execution (select-all + Run). Runs as the editor's
-- superuser (postgres): these checks verify MIGRATIONS, not RLS.
-- RLS behavior is probed by files 10-50, which switch identity explicitly.
--
-- APPLY ORDER (Supabase dashboard -> SQL editor, in order; each file is
-- idempotent — safe to re-run):
--   1. supabase/migrations/0001_init.sql
--   2. supabase/seed.sql
--   3. supabase/migrations/0002_storage.sql
--   4. supabase/migrations/0003_rls_hardening.sql
--   5. supabase/migrations/0004_deletion_requests.sql
--   6. supabase/migrations/0005_ai_credentials_provider.sql
--   7. supabase/migrations/0006_rls_least_privilege.sql
--   8. supabase/migrations/0007_scalability_indexes_counts.sql
--   9. supabase/migrations/0008_rls_private_messages.sql
--   10. realtime `alter publication ...` snippet from details.md
--
-- STAGING FIXTURE needed before files 10-50 (create via the app):
--   WS_A      : primary workspace uuid
--   WS_B      : second workspace uuid (different members)
--   ADMIN     : user uuid, admin of WS_A
--   USER_A    : user uuid, plain member of WS_A
--   USER_B    : user uuid, member of WS_B only
--   PENDING_DOC: uuid of a `pending` document in WS_A *uploaded by USER_A*
--     (the 20_records.sql T6 probe needs the row visible to the member)
--   CHAT_A    : uuid of a workspace-visible chat in WS_A owned by USER_A
-- Find them with:
--   select id, email from auth.users;
--   select id, name from public.workspaces;
--   select user_id, workspace_id, role, status from public.workspace_members;
--   select id, workspace_id, status, uploaded_by from public.documents
--    where status = 'pending' limit 5;
--   select id, workspace_id, owner_id from public.chats limit 5;
-- Each probe file has its own CONFIG block — paste the UUIDs there.
-- A file raises EXCEPTION with a PROBE FAIL tag on any mismatch; a clean
-- run ends with a NOTICE. Reruns are safe (probe rows are namespaced and
-- cleaned up by each file's prologue).
-- ============================================================================

-- 0005 applied? ai_credentials PK must cover (user_id, provider).
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conrelid = 'public.ai_credentials'::regclass AND contype = 'p';
  IF def IS NULL OR def NOT LIKE '%(user_id, provider)%' THEN
    RAISE EXCEPTION 'SETUP FAIL: ai_credentials PK is %, expected (user_id, provider) — apply 0005', def;
  END IF;
  RAISE NOTICE 'setup ok: ai_credentials PK %', def;
END $$;

-- 0006 applied? New least-privilege policies present, replaced ones gone.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(x.p) INTO missing FROM (VALUES
    ('trail_member_insert'), ('trail_admin_write'), ('trail_admin_delete'),
    ('queries_member_insert'), ('queries_admin_write'), ('queries_admin_delete'),
    ('chunks_member_insert'), ('chunks_admin_write'), ('chunks_admin_delete'),
    ('embeddings_admin_update')
  ) AS x(p)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = x.p
  );
  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'SETUP FAIL: 0006 policies missing: % — apply 0006', missing;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'shared_member_write'
      AND tablename IN ('research_trail', 'research_queries', 'document_chunks')
  ) THEN
    RAISE EXCEPTION 'SETUP FAIL: old shared_member_write still present on trail/queries/chunks';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'document_embeddings'
      AND policyname = 'embeddings_update'
  ) THEN
    RAISE EXCEPTION 'SETUP FAIL: old member embeddings_update still present';
  END IF;
  RAISE NOTICE 'setup ok: 0006 least-privilege policies present';
END $$;

-- RLS enabled on every policy-bearing table touched by 0005/0006.
DO $$
DECLARE
  open_tables text[];
BEGIN
  SELECT array_agg(tablename) INTO open_tables FROM pg_tables
  WHERE schemaname = 'public' AND rowsecurity = false
    AND tablename IN (
      'ai_credentials', 'research_trail', 'research_queries',
      'document_chunks', 'document_embeddings'
    );
  IF open_tables IS NOT NULL AND array_length(open_tables, 1) > 0 THEN
    RAISE EXCEPTION 'SETUP FAIL: RLS not enabled on: %', open_tables;
  END IF;
  RAISE NOTICE 'setup ok: RLS enabled on all touched tables';
END $$;

-- Storage bucket policies (0002 + 0006 segment match) present.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(x.p) INTO missing FROM (VALUES
    ('documents_bucket_read_members'),
    ('documents_bucket_insert_members'),
    ('documents_bucket_delete_admin')
  ) AS x(p)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = x.p
  );
  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'SETUP FAIL: storage policies missing: %', missing;
  END IF;
  RAISE NOTICE 'setup ok: storage bucket policies present';
END $$;

-- 0007 applied? Scalability indexes + count RPCs present.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(x.i) INTO missing FROM (VALUES
    ('idx_document_tags_tag'), ('idx_document_collections_collection'),
    ('idx_document_authors_author'), ('idx_claims_project'),
    ('idx_evidence_project'), ('idx_research_queries_project_created'),
    ('idx_source_citations_source'), ('idx_saved_searches_ws'),
    ('idx_documents_ws_created'), ('idx_chunks_ws')
  ) AS x(i)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = x.i
  );
  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'SETUP FAIL: 0007 indexes missing: % — apply 0007', missing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('collection_doc_counts', 'tag_doc_counts', 'project_doc_counts')
    GROUP BY n.nspname HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'SETUP FAIL: 0007 count RPCs missing — apply 0007';
  END IF;
  RAISE NOTICE 'setup ok: 0007 indexes + count RPCs present';
END $$;

-- 0008 applied? chat_messages SELECT must mirror parent-chat visibility.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO def
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'chat_messages' AND pol.polname = 'chat_messages_read_ws';
  IF def IS NULL OR def NOT LIKE '%visibility%' THEN
    RAISE EXCEPTION 'SETUP FAIL: chat_messages_read_ws does not check visibility — apply 0008 (private messages leak)';
  END IF;
  RAISE NOTICE 'setup ok: 0008 private-message policy present';
END $$;

-- Informational: per-user credential counts (multi-row only possible post-0005).
SELECT user_id, count(*) AS keys, string_agg(provider, ',' ORDER BY provider) AS providers
FROM public.ai_credentials
GROUP BY user_id;
