-- ============================================================================
-- 10_auth_workspace.sql — authentication + workspace isolation (Task B).
-- Run in ONE execution. Configure the literals, then Run.
-- Fails with PROBE FAIL on any mismatch; ends with NOTICE on success.
-- Self-cleaning: creates no rows.
-- ============================================================================

-- CONFIG (staging UUIDs — see 00_setup.sql for how to find them).
--   WS_A  primary workspace | WS_B second workspace
--   USER_A member of WS_A only | ADMIN admin of WS_A
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace WS_A/WS_B/USER_A/ADMIN literals in this file';
  END IF;
END $$;

-- A1: anonymous callers see nothing and cannot write. ------------------------
SET ROLE anon;
RESET request.jwt.claims;
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.documents;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A1]: anon sees % documents', n; END IF;
  SELECT count(*) INTO n FROM public.workspace_members;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A1]: anon sees % membership rows', n; END IF;
  BEGIN
    INSERT INTO public.research_trail (workspace_id, event_type) VALUES ('11111111-1111-1111-1111-111111111111', 'probe');
    RAISE EXCEPTION 'PROBE FAIL [A1]: anon trail INSERT succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL; -- expected: RLS denied (42501)
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [A1]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

-- A2: USER_A sees exactly their own workspace. --------------------------------
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  -- non-vacuous: own active membership must be visible.
  SELECT count(*) INTO n FROM public.workspace_members
  WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
    AND user_id = '33333333-3333-3333-3333-333333333333' AND status = 'active';
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [A2]: own membership not visible'; END IF;
  -- no rows from the foreign workspace anywhere.
  SELECT count(*) INTO n FROM public.documents WHERE workspace_id = '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A2]: USER_A sees % WS_B documents', n; END IF;
  SELECT count(*) INTO n FROM public.workspace_members WHERE workspace_id = '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A2]: USER_A sees % WS_B membership rows', n; END IF;
  SELECT count(*) INTO n FROM public.research_trail WHERE workspace_id = '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A2]: USER_A sees % WS_B trail rows', n; END IF;
END $$;

-- A3: cross-workspace isolation — USER_B (member of WS_B only) sees nothing
-- of WS_A, even though authenticated.
SET request.jwt.claims TO '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.documents WHERE workspace_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [A3]: outsider sees % WS_A documents', n; END IF;
END $$;

RESET ROLE;
RESET request.jwt.claims;
DO $$ BEGIN RAISE NOTICE 'PROBES PASSED: 10_auth_workspace'; END $$;
