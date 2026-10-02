-- ============================================================================
-- 20_records.sql — record ownership + 0006 least-privilege matrix (Task B).
-- Run in ONE execution. Fails with PROBE FAIL on mismatch.
-- Side-effect discipline: every allowed mutation is reverted or cleaned up;
-- denied attempts change nothing. Reruns are safe (prologue purges leftovers).
-- Prerequisites (staging): WS_A with a PENDING doc, ≥1 embedded chunk,
-- and a workspace-visible chat owned by USER_A.
-- ============================================================================

-- CONFIG (staging UUIDs).
--   WS_A, USER_A (member), USER_B (WS_B only), ADMIN (admin of WS_A),
--   PENDING_DOC (a *pending* document in WS_A *uploaded by USER_A* — this makes
--     T6 deterministic: the row is visible to USER_A, so only the admin-only
--     status-flip rule can deny the write),
--   CHAT_A (WS_A chat owned by USER_A)

-- Prologue: purge leftovers from an interrupted run (runs as editor role).
DELETE FROM public.research_trail WHERE event_type = 'probe';
DELETE FROM public.research_queries WHERE query = 'probe';
DELETE FROM public.document_chunks WHERE content = 'probe-chunk';
DELETE FROM public.chat_messages WHERE content = 'probe-message';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace WS_A/USER_A/USER_B/ADMIN/PENDING_DOC/CHAT_A literals';
  END IF;
END $$;

-- T1/T2: research_trail append-only for members. -----------------------------
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  tid uuid;
BEGIN
  INSERT INTO public.research_trail (workspace_id, event_type)
  VALUES ('11111111-1111-1111-1111-111111111111', 'probe') RETURNING id INTO tid;
  BEGIN
    UPDATE public.research_trail SET event_type = 'probe-x' WHERE id = tid;
    RAISE EXCEPTION 'PROBE FAIL [T1]: member UPDATE research_trail succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T1]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
  BEGIN
    DELETE FROM public.research_trail WHERE id = tid;
    RAISE EXCEPTION 'PROBE FAIL [T1]: member DELETE research_trail succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T1]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  -- Admin no-op update exercises USING + WITH CHECK without mutating data.
  UPDATE public.research_trail SET event_type = event_type
  WHERE event_type = 'probe' AND workspace_id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T2]: admin cannot update trail (probe row missing?)'; END IF;
  DELETE FROM public.research_trail
  WHERE event_type = 'probe' AND workspace_id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T2]: admin cannot delete trail'; END IF;
END $$;

-- T3: research_queries history is never edited by members. --------------------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  qid uuid;
BEGIN
  INSERT INTO public.research_queries (workspace_id, query)
  VALUES ('11111111-1111-1111-1111-111111111111', 'probe') RETURNING id INTO qid;
  BEGIN
    UPDATE public.research_queries SET query = 'probe-x' WHERE id = qid;
    RAISE EXCEPTION 'PROBE FAIL [T3]: member UPDATE research_queries succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T3]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
  BEGIN
    DELETE FROM public.research_queries WHERE id = qid;
    RAISE EXCEPTION 'PROBE FAIL [T3]: member DELETE research_queries succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T3]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  UPDATE public.research_queries SET query = query
  WHERE query = 'probe' AND workspace_id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T3]: admin cannot update queries'; END IF;
  DELETE FROM public.research_queries
  WHERE query = 'probe' AND workspace_id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T3]: admin cannot delete queries'; END IF;
END $$;

-- T4: document_chunks — member INSERT only. -----------------------------------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  existing uuid;
BEGIN
  INSERT INTO public.document_chunks (workspace_id, document_id, content, chunk_index)
  VALUES ('11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'probe-chunk', 0);
  SELECT id INTO existing FROM public.document_chunks
  WHERE workspace_id = '11111111-1111-1111-1111-111111111111' AND content <> 'probe-chunk'
  ORDER BY created_at LIMIT 1;
  IF existing IS NULL THEN RAISE EXCEPTION 'PROBE FAIL [T4]: no pre-existing chunk to probe (ingest one first)'; END IF;
  BEGIN
    UPDATE public.document_chunks SET content = content WHERE id = existing;
    RAISE EXCEPTION 'PROBE FAIL [T4]: member UPDATE chunks succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T4]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
  BEGIN
    DELETE FROM public.document_chunks WHERE id = existing;
    RAISE EXCEPTION 'PROBE FAIL [T4]: member DELETE chunks succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T4]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  UPDATE public.document_chunks SET content = content
  WHERE content = 'probe-chunk' AND workspace_id = '11111111-1111-1111-1111-111111111111';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T4]: admin cannot update chunks'; END IF;
END $$;

-- T5: document_embeddings — member UPDATE narrowed to admin. ------------------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  eid uuid;
BEGIN
  SELECT e.id INTO eid FROM public.document_embeddings e
  JOIN public.document_chunks c ON c.id = e.chunk_id
  WHERE c.workspace_id = '11111111-1111-1111-1111-111111111111' LIMIT 1;
  IF eid IS NULL THEN RAISE EXCEPTION 'PROBE FAIL [T5]: no embedding in WS_A (ingest with embeddings first)'; END IF;
  BEGIN
    UPDATE public.document_embeddings SET model_name = model_name WHERE id = eid;
    RAISE EXCEPTION 'PROBE FAIL [T5]: member UPDATE embeddings succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T5]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  UPDATE public.document_embeddings SET model_name = model_name
  WHERE id IN (SELECT e.id FROM public.document_embeddings e
               JOIN public.document_chunks c ON c.id = e.chunk_id
               WHERE c.workspace_id = '11111111-1111-1111-1111-111111111111' LIMIT 1);
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T5]: admin cannot update embeddings'; END IF;
END $$;

-- T6: documents approval flip — members denied, admin allowed (reverted). -----
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
BEGIN
  UPDATE public.documents SET status = 'approved' WHERE id = '66666666-6666-6666-6666-666666666666';
  RAISE EXCEPTION 'PROBE FAIL [T6]: member status flip succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T6]: wrong error % (%)', SQLERRM, SQLSTATE;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  UPDATE public.documents SET status = 'approved' WHERE id = '66666666-6666-6666-6666-666666666666';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T6]: admin cannot approve'; END IF;
  UPDATE public.documents SET status = 'pending' WHERE id = '66666666-6666-6666-6666-666666666666';
END $$;

-- T7: chat messages — owner writes, others denied. -----------------------------
SET request.jwt.claims TO '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
DO $$
BEGIN
  INSERT INTO public.chat_messages (chat_id, role, content)
  VALUES ('77777777-7777-7777-7777-777777777777', 'user', 'probe-message');
  RAISE EXCEPTION 'PROBE FAIL [T7]: non-owner message INSERT succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [T7]: wrong error % (%)', SQLERRM, SQLSTATE;
END $$;

SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  mid uuid;
BEGIN
  INSERT INTO public.chat_messages (chat_id, role, content)
  VALUES ('77777777-7777-7777-7777-777777777777', 'user', 'probe-message') RETURNING id INTO mid;
  DELETE FROM public.chat_messages WHERE id = mid;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [T7]: owner cannot delete own message'; END IF;
END $$;

-- Epilogue cleanup (as editor role) + reset identity. --------------------------
RESET ROLE;
RESET request.jwt.claims;
DELETE FROM public.document_chunks WHERE content = 'probe-chunk';
DELETE FROM public.chat_messages WHERE content = 'probe-message';
DO $$ BEGIN RAISE NOTICE 'PROBES PASSED: 20_records'; END $$;
