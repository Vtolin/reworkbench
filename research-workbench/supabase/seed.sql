-- Seed for local development only (supabase db reset / seed).
-- Creates no users (auth.users is managed). Documents the expected bootstrap:
-- 1. POST /api/auth/register-admin {email,password,admin_key} creates the
--    Supabase user + workspace + admin membership (service role).
-- 2. Members join via /register (respects member_limit, capped by MAX_ALLOWED_MEMBERS=10).
-- 3. Storage bucket `documents` must exist (private).

-- Storage buckets (run once; harmless if they exist)
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
