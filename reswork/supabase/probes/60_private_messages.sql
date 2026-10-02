-- ============================================================================
-- 60_private_messages.sql — private chat message visibility (migration 0008).
-- FAILS on 0001–0007, passes with 0008: chat_messages SELECT was gated on
-- workspace membership alone, so any member holding a chat_id could read
-- PRIVATE chats (stored backups). 0008 mirrors chats_read_ws on the message
-- policy (workspace-visible, owner, or admin).
-- Run in ONE execution. Reruns are safe (namespaced fixture, full cleanup).
-- ============================================================================

-- CONFIG (staging UUIDs): WS_A, USER_A (member of WS_A), ADMIN (admin of WS_A),
-- USER_B (member of WS_B only — temporarily added to WS_A below, then removed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace WS_A/USER_A/ADMIN/USER_B literals in this file';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_members
             WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
               AND user_id = '44444444-4444-4444-4444-444444444444' AND status = 'active') THEN
    RAISE EXCEPTION 'PROBE FIXTURE VIOLATED: USER_B already active in WS_A (30_privilege depends on this)';
  END IF;
END $$;

-- Prologue: clean stale fixture, add USER_B to WS_A as plain member. ---------
RESET ROLE;
DELETE FROM public.chats WHERE title LIKE 'probe60-%';
DELETE FROM public.workspace_members
WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
  AND user_id = '44444444-4444-4444-4444-444444444444';
INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
VALUES ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'member', 'active');

-- Fixture: private chat + message owned by USER_A (inserted AS USER_A: owner
-- insert requires owner_id = auth.uid()).
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  priv uuid;
BEGIN
  INSERT INTO public.chats (workspace_id, owner_id, title, visibility)
  VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'probe60-private', 'private')
  RETURNING id INTO priv;
  INSERT INTO public.chat_messages (chat_id, role, content)
  VALUES (priv, 'user', 'probe60-secret');
  INSERT INTO public.chats (workspace_id, owner_id, title, visibility)
  VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'probe60-shared', 'workspace')
  RETURNING id INTO priv;
  INSERT INTO public.chat_messages (chat_id, role, content)
  VALUES (priv, 'user', 'probe60-open');
END $$;

-- M1 (positive control): owner reads own private messages. -------------------
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.chat_messages
  WHERE content = 'probe60-secret';
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [M1]: owner read % private rows, expected 1', n; END IF;
END $$;

-- M2 (the hole): a non-owner member must NOT read private messages. ----------
SET request.jwt.claims TO '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.chat_messages
  WHERE content = 'probe60-secret';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [M2]: member read % private message rows (0008 missing?)', n; END IF;
END $$;

-- M3: admin override preserved (repair/audit still works). --------------------
SET request.jwt.claims TO '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.chat_messages
  WHERE content = 'probe60-secret';
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [M3]: admin read % private rows, expected 1', n; END IF;
END $$;

-- M4: workspace-visible messages still readable by a member. ------------------
SET request.jwt.claims TO '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.chat_messages
  WHERE content = 'probe60-open';
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [M4]: member read % shared rows, expected 1', n; END IF;
END $$;

-- Epilogue: remove fixture + temporary membership (chat cascade clears messages).
RESET ROLE;
DELETE FROM public.chats WHERE title LIKE 'probe60-%';
DELETE FROM public.workspace_members
WHERE workspace_id = '11111111-1111-1111-1111-111111111111'
  AND user_id = '44444444-4444-4444-4444-444444444444';

DO $$ BEGIN RAISE NOTICE 'probe 60 ok: private messages visible to owner/admin, hidden from members'; END $$;
