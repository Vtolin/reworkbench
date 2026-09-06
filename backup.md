# BACKUP — restore point before full UI migration

**Date:** 2026-09-06
**Git checkpoint:** `0c0b857` — "checkpoint: pre-migration state (local FastAPI app + cloud MVP in research-workbench/)"
**Repo:** `C:\Users\Pasha\Desktop\online` (git root; old `web/` also has its own nested `.git` with full history)

## State at checkpoint (all verified working)

- **Cloud MVP** in `research-workbench/` (`web/` Next.js app + `supabase/` migrations + docs).
  `tsc --noEmit` clean, `next build` passes (21 routes).
- **Supabase project ref:** `xxwdwinklkhfacqmnjyh` (tables from `0001_init.sql` + `0002_storage.sql` applied,
  `documents` bucket created, realtime publication set for 6 tables).
- **Live env file:** `research-workbench/web/.env.local` (5 keys set, URL has no trailing slash).
  NOTE: an earlier wrong copy existed at `web/.env.local` (old app) — that file is retired with the old stack.
- **Verified behaviors:** admin registration creates workspace; member join respects limit; approve flow;
  Research/Chats answer via local Ollama (`gemma4:26b-a4b-it-qat`, cold start slow as expected);
  local `nomic-embed-text` embeddings; BYOK cloud proxy present (not yet live-tested).
- **Old local app** fully intact at checkpoint: `web/` (Next.js), `server.py` + root `*.py`, `core/`,
  `storage/`, `tests/`, `browser-extension/`, `details.md` (technical reference for the port).

## What the migration (starting now) does

1. Moves user data (untracked, on-disk only) → `_archive/`:
   - `pfolder/` (source PDFs), `research_workbench/data/` (`library.db` + content-addressed documents),
     `summaries/`. Excluded from git by design; NOT deleted.
2. Deletes the retired local stack (recoverable via git `0c0b857`): old `web/`, `server.py`, root `*.py`,
   `core/`, `storage/`, `tests/`, `browser-extension/`, `chroma_db/`, `rerank_cache/`, `venv/` left on disk
   (git-ignored), old `README.md`/`details.md` (superseded; originals in git history).
3. Promotes the app: `research-workbench/web/*` → `research-workbench/*` (Vercel Root Directory
   becomes `research-workbench`). Moves live `.env.local` + `node_modules` with it.
4. Ports the original UI 1:1 onto Supabase + browser-side inference (see `research-workbench/details.md` roadmap).

## How to revert

- **Code (exact):** `git log --oneline` → find this checkpoint `0c0b857` →
  `git checkout 0c0b857` (or `git revert`/`reset` to it). Everything deleted in step 2 comes back.
- **User data:** copy back from `_archive/pfolder/`, `_archive/research_workbench_data/` to original paths.
- **Database:** Supabase tables are additive (`IF NOT EXISTS`); nothing in the migration drops cloud data.
- **Old web's own history:** `web/` had a nested `.git` — its history is inside the checkpoint too.
