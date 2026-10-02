-- 0005: ai_credentials cardinality fix — one row per (user_id, provider).
--
-- The application stores one BYOK key per cloud provider per user
-- (Settings saves {provider, apiKey}; rag/embed selects by provider; the
-- proxy resolves per provider), but the original PRIMARY KEY (user_id)
-- allowed only one row per user: saving a second provider's key silently
-- overwrote the first via the PUT upsert.
--
-- Existing rows are unique per user_id by construction of the old key, so
-- re-keying on (user_id, provider) is lossless — no deletes, no backfill.
-- RLS (owner-only on user_id) is unchanged and stays correct under the
-- composite key. Application code updated in step: PUT upserts with
-- onConflict=user_id,provider; DELETE scopes by provider when given.

alter table public.ai_credentials drop constraint if exists ai_credentials_pkey;
alter table public.ai_credentials add primary key (user_id, provider);
