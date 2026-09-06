# Research Workbench — Cloud Version

Multi-user, cloud-coordinated, locally-executed AI research workspace.
**Supabase owns the collaborative research state. The browser owns the AI connection.**

This is the full migration of the original local app: the **same UI** (Library, Search, Research, Projects, Reader, Upload, Settings) now runs on Supabase + browser-side inference instead of FastAPI + SQLite + Chroma.

## Architecture

- **Vercel + Next.js 16** (this directory — the app root) — UI, auth screens, API routes, cloud-AI proxy, authorization.
- **Supabase** (`supabase/`) — Postgres, Auth, Storage, Realtime, `pgvector`, FTS.
- **Browser** — calls local Ollama (`localhost:11434`) directly, or Vercel → cloud (BYOK).

No FastAPI, no SQLite, no Chroma, no `pfolder/`, no watch-folder daemon.

## Quick start (local dev)

1. Create a Supabase project, then in **SQL Editor** run in order:
   `supabase/migrations/0001_init.sql` → `supabase/seed.sql` → `supabase/migrations/0002_storage.sql`,
   plus the realtime `alter publication …` snippet from `details.md`.
2. Copy `.env.example` to `.env.local` and fill it (Supabase URL/keys from
   Project Settings → Data API; invent `ADMIN_REGISTRATION_KEY` and `CREDENTIALS_ENCRYPTION_KEY`).
3. `npm install && npm run dev` → http://localhost:3000
4. `/register` with the admin box checked → workspace created → `/` library.
5. Each member installs Ollama (`ollama pull nomic-embed-text gemma4:26b-a4b-it-qat`)
   or saves their own cloud key in Settings → Chat.

## Deploy (Vercel)

- Import this repo, set **Root Directory** to `research-workbench`.
- Add the same env vars from `.env.example` in Vercel → Project → Settings → Environment Variables.
- Deploy. Inference still runs on each member's machine — Vercel only serves the UI + API routes.

## Key flows

- **Upload → approval**: member uploads (browser extracts/chunks/embeds, OpenAlex proposal, human confirms) → `pending` → admin approves in Admin dashboard → shared library.
- **Chat**: read any workspace chat; continue only your own; "Import to my chats" branches (Chats page). Research page keeps the original per-device chat history + streaming UI.
- **RAG**: Postgres FTS + pgvector → RRF fusion → your own model (Ollama local or BYOK cloud).
- **Keys**: personal BYOK, AES-GCM at rest (`ai_credentials`, owner-only RLS), never shared.

## Project layout

```
research-workbench/
├── src/
│   ├── app/            # /, /search, /research, /projects, /chats, /reader, /upload, /settings, /admin, /login, /register + /api/*
│   ├── components/     # Sidebar, Topbar, DocDetail, UploadFlow, Markdown, ChatHistoryPanel, …
│   ├── contexts/       # Session, Inference (local-only), Chat (per-device history)
│   └── lib/
│       ├── api.ts      # facade: original method names → Supabase + browser inference
│       ├── wb/         # library, search, ask, projects, related, ingest, openalex
│       ├── ai/         # AIProvider, OllamaProvider, CloudProvider, key encryption
│       ├── rag/        # FTS+pgvector retrieval + RRF fusion
│       ├── citations/  # citeproc-js engine + serializers
│       ├── importing/  # BibTeX/RIS/EndNote/CSL-JSON parsers
│       ├── legal/      # deterministic case/citation extraction
│       └── ingestion/  # dedup, classify, chunking (4700/880)
├── supabase/           # migrations, seed, config, edge functions
├── public/csl/         # vendored CSL styles + en-US locale
├── README.md
└── details.md          # full technical reference
```

## New laptop onboarding (per member, per machine — one time)

Each member picks **one** inference path on each device. Nothing is shared between members.

**Option A — local Ollama (private, recommended)**
1. Install Ollama, then: `ollama pull nomic-embed-text` (required for vector search)
   plus any chat model, e.g. `ollama pull gemma4:26b-a4b-it-qat`.
2. Make sure it's serving: open `http://localhost:11434/` → "Ollama is running".
3. In the app: register/login → Settings → provider **Ollama** → **Auto-detect Ollama models**.
4. **Vercel-URL users only**: if you open the app via `*.vercel.app` (not `localhost:3000`),
   allowlist that origin once, then quit + relaunch Ollama (tray icon → Quit → start):
   ```powershell
   setx OLLAMA_ORIGINS "https://YOUR-APP.vercel.app"
   ```
   `localhost:3000` dev never needs this (localhost origins are allowed by default).
   Verify with `echo $env:OLLAMA_ORIGINS` in a new terminal.

**Option B — cloud key (no install)**
Settings → provider **Cloud** → pick OpenAI/DeepSeek/Google/Anthropic → paste your **own**
key → Save → **↻ Models** to list live model ids. Keys are encrypted per-user, never shared.

Cold-start note: Ollama unloads idle models after ~5 min, so the first question after
idle is slow (large models take a while to reload), then fast until idle again.

See `details.md` for the complete reference, including honest behavior deltas vs the original.
