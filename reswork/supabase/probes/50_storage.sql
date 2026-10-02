-- ============================================================================
-- 50_storage.sql — documents-bucket object policies (Task B).
-- Run in ONE execution. Probe objects are fake rows (no file bytes) named
-- probe-*.txt and are deleted at the end. Reruns are safe.
-- Covers the 0006 segment-match fix: a name that merely SHARES A STRING
-- PREFIX with the workspace id must be denied (old position() check allowed
-- it); traversal-shaped names stay scoped by their first segment.
-- Prerequisite: the `documents` bucket exists (created via dashboard/CLI).
-- ============================================================================

-- CONFIG (staging UUIDs): WS_A, WS_B, USER_A (member of WS_A), ADMIN (admin).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'documents') THEN
    RAISE EXCEPTION 'PROBE FIXTURE VIOLATED: storage bucket documents does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace WS_A/WS_B/USER_A/ADMIN literals in this file';
  END IF;
  DELETE FROM storage.objects WHERE name LIKE 'probe-%' AND bucket_id = 'documents';
END $$;

-- S1: member writes own-prefix objects; foreign prefix denied. ----------------
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
BEGIN
  INSERT INTO storage.objects (bucket_id, name, owner)
  VALUES ('documents', '11111111-1111-1111-1111-111111111111/probe-a.txt', '33333333-3333-3333-3333-333333333333');
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('documents', '22222222-2222-2222-2222-222222222222/probe-evil.txt', '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'PROBE FAIL [S1]: foreign-prefix INSERT succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [S1]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
  -- Prefix-collision regression (0006): '<ws>-suffix/...' starts with the ws
  -- id as a string but is NOT its first path segment — must be denied.
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('documents', '11111111-1111-1111-1111-111111111111-suffix/probe-evil.txt', '33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'PROBE FAIL [S1]: prefix-collision INSERT succeeded (0006 not applied?)';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [S1]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

-- S2: reads are prefix-scoped; deletes are admin-only. -------------------------
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM storage.objects
  WHERE bucket_id = 'documents' AND name LIKE '%probe-%';
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [S2]: member sees % probe rows, expected 1', n; END IF;
  BEGIN
    DELETE FROM storage.objects
    WHERE bucket_id = 'documents' AND name = '11111111-1111-1111-1111-111111111111/probe-a.txt';
    RAISE EXCEPTION 'PROBE FAIL [S2]: member DELETE succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [S2]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  DELETE FROM storage.objects
  WHERE bucket_id = 'documents' AND name = '11111111-1111-1111-1111-111111111111/probe-a.txt';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [S2]: admin cannot delete own-prefix object'; END IF;
END $$;

RESET ROLE;
RESET request.jwt.claims;
DO $$ BEGIN RAISE NOTICE 'PROBES PASSED: 50_storage'; END $$;
