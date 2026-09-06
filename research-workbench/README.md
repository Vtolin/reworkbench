# Research Workbench — Cloud Migration

Multi-user, cloud-coordinated, locally-executed AI research workspace.
**Supabase owns the collaborative research state. The browser owns the AI connection.**

## Architecture

- **Vercel + Next.js 16** (`web/`) — UI, auth, dashboard, API routes, cloud-AI proxy, authorization.
- **Supabase** (`supabase/`) — Postgres, Auth, Storage, Realtime, `pgvector`, FTS.
- **Browser** — calls local Ollama (`localhost:11434`) directly, or Vercel → cloud (BYOK).

No FastAPI, no SQLite, no Chroma, no `pfolder/`, no watch-folder daemon.

## Quick start

1. Create a Supabase project, enable `pgvector`, run migrations:
   `supabase db push` (applies `supabase/migrations/*.sql`).
   Create the private `documents` Storage bucket (see `supabase/seed.sql`).
2. `cd web && cp ../web/.env.example .env.local` — fill in Supabase URL/keys,
   `ADMIN_REGISTRATION_KEY`, `MAX_ALLOWED_MEMBERS=10`, `CREDENTIALS_ENCRYPTION_KEY`.
3. `npm install && npm run dev` → http://localhost:3000
4. Register as admin (`/register` → admin checkbox + key), invite members (`/register`).
5. Each member installs Ollama (`ollama pull nomic-embed-text gemma4:26b-a4b-it-qat`)
   or saves their own cloud key in Research → Settings.

## Key flows

- **Upload → approval**: member uploads (browser extracts/chunks/embeds) → `pending` →
  admin approves → shared library.
- **Chat**: read any workspace chat; continue only your own; "Import to my chats" branches.
- **RAG**: FTS + pgvector → RRF fusion → your own model. Embedding mode toggle (local/server).
- **Keys**: personal BYOK, AES-GCM at rest (`ai_credentials`, owner-only RLS), never shared.

## Project layout

See `details.md` for the full technical reference.
