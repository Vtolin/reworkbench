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

## Joining on a new laptop (do this once per computer)

The library is shared, but the AI runs on **your own computer**. So each person,
on each computer they use, picks one of the two options below. Nothing is shared
between members — your models and keys stay yours.

**Option A — run the AI on your computer (private, recommended)**

1. Install Ollama and open it at least once:
   - **Windows**: download from ollama.com (it lives by the clock, bottom-right).
   - **Mac (Apple Silicon)**: download from ollama.com (it lives in the top menu bar).
     Apple chips run models fast with no extra setup.
   - **Linux**: open Terminal and run `curl -fsSL https://ollama.com/install.sh | sh`
     (it starts itself in the background).
2. Download the models the app needs — open a terminal (PowerShell on Windows,
   Terminal on Mac/Linux) and paste one line at a time, Enter after each:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen3.5:4b
   ollama pull qwen2.5:7b
   ollama pull gpt-oss:20b
   ```
   The first one is required for searching; the rest are chat models.
   Rule of thumb: `gemma4:26b-a4b-it-qat` if your machine is strong,
   `qwen2.5:7b` if it's modest. Any Ollama model works, pick what fits.
3. Check Ollama is awake: in your browser open `http://localhost:11434/`.
   You should see the words **"Ollama is running"**. If not, start the Ollama app
   (Linux: `sudo systemctl start ollama`).
4. Open the Workbench site and log in. Go to **Settings** → provider **Ollama** →
   click **Auto-detect Ollama models**. If it lists your models, you're connected.
5. **Only if you open the site via a `vercel.app` address** (not `localhost:3000`):
   Ollama blocks websites it doesn't know, so introduce them once.
   (Use the real address from your browser bar, e.g.
   `https://research-workbench-topaz.vercel.app` — exactly that, nothing after it.)
   - **Windows** (PowerShell):
     ```powershell
     setx OLLAMA_ORIGINS "https://YOUR-APP.vercel.app"
     ```
     Then **fully restart Ollama**: right-click its icon by the clock → **Quit**,
     then open Ollama again from the Start menu. Just closing the browser tab is
     not enough — the Ollama program itself must restart.
   - **Mac** (Terminal):
     ```bash
     launchctl setenv OLLAMA_ORIGINS "https://YOUR-APP.vercel.app"
     ```
     Then quit Ollama from the top menu bar and reopen it from Applications.
     (Re-run this command after a reboot — macOS forgets it on restart.
     Alternative that lasts as long as the window stays open: quit the menu-bar
     app, then run `OLLAMA_ORIGINS="https://YOUR-APP.vercel.app" ollama serve`.)
   - **Linux** (Terminal — permanent, survives reboots):
     ```bash
     sudo systemctl edit ollama
     ```
     An editor opens — paste these two lines, save, exit:
     ```
     [Service]
     Environment="OLLAMA_ORIGINS=https://YOUR-APP.vercel.app"
     ```
     Then `sudo systemctl restart ollama`.
6. Confirm it worked, in a **new** terminal window:
   - Check the setting stuck:
     - Windows: `echo $env:OLLAMA_ORIGINS` · Mac/Linux: `echo $OLLAMA_ORIGINS`
     - (Linux systemd users: `systemctl show ollama --property=Environment` instead.)
     It should print your address back.
   - Ask Ollama directly, pretending to be the website:
     - Windows:
       ```powershell
       Invoke-WebRequest -UseBasicParsing -Uri http://localhost:11434/api/tags -Headers @{Origin="https://YOUR-APP.vercel.app"} | Select-Object StatusCode
       ```
       (If PowerShell asks "Script Execution Risk", answer **Y**.)
     - Mac/Linux:
       ```bash
       curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://YOUR-APP.vercel.app" http://localhost:11434/api/tags
       ```
   - You want `200`. `403` means Ollama is still the old one — repeat step 5.

**Option B — use a cloud AI key (nothing to install)**

1. Get an API key from one provider: OpenAI, DeepSeek, Google, or Anthropic.
2. In the app: **Settings** → provider **Cloud** → pick that provider →
   paste **your own** key → **Save key**.
3. Click **↻ Models** — the app lists that provider's real models; pick one.
   Your key is encrypted and visible only to you.

**Everyday notes**

- First question after a break is slow: Ollama unloads idle models after ~5 minutes,
  so it reloads once (large models take a bit), then stays fast.
- "Failed to fetch" in Research almost always means Ollama isn't awake on that
  computer — redo step 3 above.
- You only ever do the setup steps once per computer. After that: log in and work.

See `details.md` for the complete reference, including honest behavior deltas vs the original.
