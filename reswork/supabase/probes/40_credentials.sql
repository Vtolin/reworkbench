-- ============================================================================
-- 40_credentials.sql — credential isolation + multi-provider cardinality
-- (Task B; regression cover for migration 0005).
-- Run in ONE execution. Uses dummy ciphertext (never real keys).
-- Net-zero: all probe rows are deleted by the end. Reruns are safe.
-- ============================================================================

-- CONFIG (staging UUIDs): USER_A (any real user), USER_B (any other user).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '33333333-3333-3333-3333-333333333333') THEN
    RAISE EXCEPTION 'PROBE NOT CONFIGURED: replace USER_A/USER_B literals in this file';
  END IF;
END $$;

-- Prologue: purge leftovers (runs as editor role).
DELETE FROM public.ai_credentials
WHERE user_id IN ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444')
  AND provider IN ('openai', 'google');

-- C1: one user can hold several provider keys (0005 cardinality). ------------
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  INSERT INTO public.ai_credentials (user_id, provider, ciphertext, iv)
  VALUES ('33333333-3333-3333-3333-333333333333', 'openai', 'probe', 'probe');
  INSERT INTO public.ai_credentials (user_id, provider, ciphertext, iv)
  VALUES ('33333333-3333-3333-3333-333333333333', 'google', 'probe', 'probe');
  SELECT count(*) INTO n FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  IF n <> 2 THEN RAISE EXCEPTION 'PROBE FAIL [C1]: expected 2 provider rows, saw %', n; END IF;
  -- App upsert pattern (PUT with onConflict user_id,provider) must update in
  -- place on the fixed schema — and must fail loudly pre-0005.
  INSERT INTO public.ai_credentials (user_id, provider, ciphertext, iv)
  VALUES ('33333333-3333-3333-3333-333333333333', 'openai', 'probe2', 'probe')
  ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext;
  SELECT count(*) INTO n FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  IF n <> 2 THEN RAISE EXCEPTION 'PROBE FAIL [C1]: upsert changed row count to %', n; END IF;
  -- Owner edits own rows.
  UPDATE public.ai_credentials SET iv = iv
  WHERE user_id = '33333333-3333-3333-3333-333333333333' AND provider = 'google';
  IF NOT FOUND THEN RAISE EXCEPTION 'PROBE FAIL [C1]: owner cannot update own key'; END IF;
END $$;

-- C2: cross-user isolation. ----------------------------------------------------
SET request.jwt.claims TO '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [C2]: USER_B sees % of USER_A keys', n; END IF;
  BEGIN
    INSERT INTO public.ai_credentials (user_id, provider, ciphertext, iv)
    VALUES ('33333333-3333-3333-3333-333333333333', 'deepseek', 'probe', 'probe');
    RAISE EXCEPTION 'PROBE FAIL [C2]: forged cross-user INSERT succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE EXCEPTION 'PROBE FAIL [C2]: wrong error % (%)', SQLERRM, SQLSTATE;
  END;
  UPDATE public.ai_credentials SET iv = iv
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [C2]: cross-user UPDATE touched % rows', n; END IF;
  DELETE FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [C2]: cross-user DELETE removed % rows', n; END IF;
END $$;

-- C3: owner-scoped delete (cleanup: leaves zero probe rows). -------------------
SET request.jwt.claims TO '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
DO $$
DECLARE
  n int;
BEGIN
  DELETE FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333' AND provider = 'google';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL [C3]: provider-scoped delete affected % rows', n; END IF;
  DELETE FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  SELECT count(*) INTO n FROM public.ai_credentials
  WHERE user_id = '33333333-3333-3333-3333-333333333333';
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL [C3]: % probe rows remain', n; END IF;
END $$;

RESET ROLE;
RESET request.jwt.claims;
DO $$ BEGIN RAISE NOTICE 'PROBES PASSED: 40_credentials'; END $$;
