-- ============================================================================
-- 30_privilege.sql — privilege boundaries: admin vs member (Task B).
-- Run in ONE execution. UPDATE-denials on visible rows surface as zero
-- affected rows (USING clause), so these probes assert ROWCOUNT, while
-- INSERT/WITH CHECK violations raise 42501 — both verify actual behavior.
-- All allowed writes are no-ops or cleaned up. Reruns are safe.
-- ============================================================================

-- CONFIG (staging UUIDs): WS_A, USER_A (member of WS_A), ADMIN (admin of WS_A),
-- CHAT_A (WS_A chat owned by USER_A).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace WS_A/USER_A/ADMIN/CHAT_A literals in this file';
  END IF;
END $$;

-- P1: workspace limit — members cannot change it, admins can (no-op). --------
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  UPDATE public.workspaces SET member_limit = member_limit
  WHERE id = '11111111-1111-1111-1111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [P1]: member changed workspace limit'; END IF;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  UPDATE public.workspaces SET member_limit = member_limit
  WHERE id = '11111111-1111-1111-1111-111111111111';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [P1]: admin no-op limit update affected % rows', n; END IF;
END $$;

-- P2: direct membership writes are admin-only. ---------------------------------
-- Uses real USER_B (member of WS_B only): the FK to auth.users is satisfied,
-- so only the RLS admin rule can deny the member attempt. Fixture guard
-- ensures B is not already in WS_A.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspace_members
             WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
               AND user_id = '44444444-4444-4444-4444-444444444444' AND status = 'active') THEN
    RAISE EXCEPTION 'PROBE FIXTURE VIOLATED: USER_B already active in WS_A';
  END IF;
END $$;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'member', 'active');
  RAISE EXCEPTION 'PROBE FAIL [P2]: member direct membership INSERT succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [P2]: wrong error % (%)', SQLERRM, SQLSTATE;
END $$;

SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'member', 'active');
END $$;

-- P3: deletion-request flow — owner files, dupes/non-owners denied. ------------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  rid uuid;
BEGIN
  INSERT INTO public.chat_deletion_requests (workspace_id, chat_id, requested_by, status)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          '33333333-3333-3333-3333-333333333333', 'pending')
  RETURNING id INTO rid;
  BEGIN
    INSERT INTO public.chat_deletion_requests (workspace_id, chat_id, requested_by, status)
    VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
            '33333333-3333-3333-3333-333333333333', 'pending');
    RAISE EXCEPTION 'PROBE FAIL [P3]: duplicate pending request succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [P3]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
END $$;

-- Non-owner files denied even for workspace admins (owner rule is separate).
SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
BEGIN
  INSERT INTO public.chat_deletion_requests (workspace_id, chat_id, requested_by, status)
  VALUES ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777777',
          '55555555-5555-5555-5555-555555555555', 'pending');
  RAISE EXCEPTION 'PROBE FAIL [P3]: non-owner deletion request succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [P3]: wrong error % (%)', SQLERRM, SQLSTATE;
END $$;
DO $$
DECLARE
  n int;
BEGIN
  -- Admin no-op decision exercises USING + WITH CHECK without mutating state.
  UPDATE public.chat_deletion_requests SET status = status
  WHERE chat_id = '77777777-7777-7777-7777-777777777777' AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [P3]: admin cannot touch deletion request'; END IF;
END $$;

-- Owner cancels own pending request (cleanup: leaves zero probe rows). ---------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
BEGIN
  DELETE FROM public.chat_deletion_requests
  WHERE chat_id = '77777777-7777-7777-7777-777777777777'
    AND requested_by = '33333333-3333-3333-3333-333333333333' AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [P3]: owner cannot cancel own request'; END IF;
END $$;

-- Epilogue: remove the admin-inserted fake member + reset identity. ------------
RESET ROLE;
RESET request.jwt.claims;
DELETE FROM public.workspace_members
WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
  AND user_id = '44444444-4444-4444-4444-444444444444';
DO $$ BEGIN RAISE NOTICE 'PROBES PASSED: 30_privilege'; END $$;
