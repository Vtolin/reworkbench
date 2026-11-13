# Research Workbench (Cloud Version)

Multi-user, cloud-coordinated, locally executed AI research workspace built with Next.js 16 and Supabase.

> **Supabase owns the collaborative research state. Your browser owns the AI connection.**

Instead of a single-machine FastAPI + SQLite + Chroma server, the full Research Workbench (Library, Search, Reader, Research, Makalah, Projects, Shared Chats, Upload, Settings, Admin) runs on Vercel/Next.js + Supabase while connecting directly to each member's own AI setup.

---

## Key Capabilities

- **Shared Library & Duplicate Merger (`/`)**: Workspace document library with collections, tags, type/year filters, citation graphs, legal citation extraction (including Indonesian legislation/putusan structure), side-by-side duplicate detection & merging, and citeproc-js bibliographies.
- **Interactive PDF Reader (`/reader/[id]`)**: `pdfjs-dist` canvas renderer paired with a synchronized selectable text pane, fallback modes, page-aware highlights (`Jump p. N`), annotation deletion, and an inline AI Q&A drawer.
- **Hybrid Retrieval & Search (`/search`)**: Reciprocal Rank Fusion across Supabase full-text search, `pgvector` semantic similarity (768d), and in-browser Okapi BM25 + cross-encoder reranking, with saved searches.
- **Research Workspace (`/research`)**:
  - **Ask**: Streaming answers with **Thinking** toggle, conversation **Memory**, **Broad** retrieval, **Hybrid** strictness (`off` to `maximum`), and an optional **Web** toggle (unlocked only after saving a Web Search API key in Settings) with Anti-AI-Slop domain/content filtering.
  - **Compare**, 3-stage **Summarize** (`stuff` / `map_reduce` + deterministic regex fact extraction), **Matrix** (CSV/Markdown/XLSX), and **Synthesis**, with PDF print, HTML, Markdown, and native OpenXML `.docx` exports.
- **Makalah Paper Pipeline (`/makalah`)**: Deterministic 4-step academic paper generator (Setup, Outline, Drafting, Result) with MMR passage allocation, opaque citation aliases against ID leakage, two-phase thinking controls, automated quality/citation integrity checks, and PDF/Markdown/DOCX export.
- **Ingestion, OCR, Zotero & Web Clipper (`/upload`, `/settings`)**: Client-side parsing for PDF, DOCX, XLSX/XLS, PPTX, RTF, TXT/MD/CSV/HTML; bulk upload (up to 10 files); bounded Vision OCR for scanned PDFs (up to 10 pages via local Ollama Vision or BYOK cloud Vision); Quick Add by DOI/ISBN/PMID/title (OpenAlex); BYOK Zotero Web API v3 import; and a Browser Web Clipper bookmarklet.
- **Workspace Governance & Auth (`/admin`, `/login`, `/register`, `/forgot-password`, `/reset-password`)**: Admin bootstrap, invite/member cap (`<= 10`), member kick, upload approval queue with an **Auto-approve uploads** toggle, ingest health & missing/full vector reindexing, orphan storage sweep, chat-deletion approvals, and email-based password reset.

---

## Using the Deployed Version (For Workspace Members)

If someone has already deployed the Workbench for your team, **you do not need to clone the repo or install Node.js or Supabase locally**. You only need:

1. An account in the deployed Workbench URL
2. Local Ollama on your computer **or** your own Cloud AI API key (BYOK)

> **Each computer runs its own AI runtime.** The deployed site does not run Ollama for Workspace members. Local Ollama requests go directly from your browser to `http://localhost:11434`.

### Option A: Local AI with Ollama (Private, Recommended)

1. Install Ollama for your OS (`ollama.com` for Windows/macOS, or `curl -fsSL https://ollama.com/install.sh | sh` on Linux) and start it.
2. Pull `nomic-embed-text` (required for semantic search/indexing) plus any chat model suited to your hardware:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen2.5:7b
   ```
   (Stronger machines can run larger models such as `gemma4:26b-a4b-it-qat`; lighter laptops can use `qwen2.5:7b` or `qwen3.5:4b`.)
3. Confirm Ollama is reachable in your browser at `http://localhost:11434/` (it should display **"Ollama is running"**).
4. In Workbench, open **Settings -> Chat**, pick **Ollama**, and click **Auto-detect Ollama models**.
5. **If using a hosted `https://...` deployment (not `localhost:3000`)**, allow the site origin in Ollama once so your browser is permitted to connect:
   - **Windows (PowerShell)**:
     ```powershell
     setx OLLAMA_ORIGINS "https://YOUR-APP.vercel.app"
     ```
     Quit Ollama from the system tray and relaunch it from the Start menu.
   - **macOS (Terminal)**:
     ```bash
     launchctl setenv OLLAMA_ORIGINS "https://YOUR-APP.vercel.app"
     ```
     Quit Ollama from the menu bar and reopen it (or run `OLLAMA_ORIGINS="https://YOUR-APP.vercel.app" ollama serve`).
   - **Linux (systemd)**:
     ```bash
     sudo systemctl edit ollama
     ```
     Add:
     ```ini
     [Service]
     Environment="OLLAMA_ORIGINS=https://YOUR-APP.vercel.app"
     ```
     Then run `sudo systemctl restart ollama`.
6. Verify the origin check returns HTTP `200` (replace with your deployed URL):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://YOUR-APP.vercel.app" http://localhost:11434/api/tags
   ```

### Option B: Cloud AI (BYOK, No Local Install)

1. Open **Settings -> Chat** and select **Cloud**.
2. Pick your provider (**OpenAI**, **DeepSeek**, **Google**, or **Anthropic**), paste your own API key, and click **Save**.
3. Click **Models** to load live models for your account and pick one.

Your key is encrypted with AES-GCM at rest in `ai_credentials` with owner-only RLS and is never visible to other workspace members.

### Option C: Optional Live Web Search (BYOK + Anti-AI-Slop Filter)

Both local Ollama and cloud models can retrieve live web sources when you opt in:

1. Open **Settings -> Web Search**.
2. Select a provider (**Ollama Web Search** free tier, **Google Search** via Gemini Search Grounding `AIza...` or Custom Search `cx:AIza...`, **Tavily AI Search**, or **Brave Search**).
3. Choose an Anti-AI-Slop filter mode:
   - **Balanced**: blocks known content farms, homework mills, scraper mirrors, and AI-slop filler while boosting `.edu`, `.ac.*`, `.gov`, `.go.id`, `doi.org`, `arxiv.org`, and official legal domains.
   - **Strict Academic & Official**: restricts web snippets strictly to academic, government/legal, and verified reference domains.
4. Save your Web Search API key. Until a key is saved for your selected search provider, the **Web** toggle in **Research -> Ask** stays locked.

---

## Architecture Overview

```text
Browser Tab (Next.js App + Local/BYOK Orchestration)
  ├──► Ollama (http://localhost:11434)          [Local chat, vision OCR & embeddings]
  └──► Next.js API Routes (/api/* on Vercel)     [Auth, RLS RPCs, AES-GCM BYOK proxies]
         ├──► Supabase (Postgres/Auth/Storage/Realtime/pgvector)
         └──► External BYOK APIs (OpenAI/DeepSeek/Google/Anthropic/Ollama Web/Tavily/Brave)
```

- **Next.js 16 + React 19** (`src/`): App Router pages, client-side document parsing/chunking/OCR/export, RAG orchestration, Makalah pipeline, and authenticated server API routes.
- **Supabase** (`supabase/`): Postgres + `pgvector` + FTS (`tsvector`), Auth (including recovery callback), private `documents` Storage bucket, Realtime subscriptions, and Postgres-backed fixed-window rate limits.

---

## Local Development Setup

Only needed if you are developing or self-hosting the app.

1. Create a Supabase project and run the SQL migrations in order inside the **SQL Editor**:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_workspace_auto_approve.sql`
2. Configure authentication redirect URLs in Supabase (`Auth -> URL Configuration`) so `/api/auth/callback` is allowed for email password resets (`/forgot-password` -> `/reset-password`).
3. Copy `.env.example` to `.env.local` and set:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_REGISTRATION_KEY` (required when registering the initial workspace admin on `/register`)
   - `CREDENTIALS_ENCRYPTION_KEY` (32+ byte secret used for AES-GCM BYOK key encryption)
   - Optional `RATE_LIMIT_*` overrides and `MAX_ALLOWED_MEMBERS` (`<= 10`).
4. Install and start the dev server:
   ```bash
   npm install
   npm run dev
   ```
5. Visit `http://localhost:3000/register`, check admin registration with your `ADMIN_REGISTRATION_KEY`, and create your workspace.

### Useful Scripts

- `npm run dev` - start Next.js development server
- `npm run build` - build production bundle
- `npm test` - run Vitest unit and architecture suites
- `npm run test:arch` - run architectural boundary checks (`src/architecture.test.ts`)
- `npm run typecheck` - run `tsc --noEmit`
- `npm run lint` - run ESLint
- `npm run test:e2e` - run Playwright end-to-end tests

---

## Deploying on Vercel

1. Import this repository into Vercel (leave Root Directory as the repository root where `package.json` resides).
2. Provision Supabase and apply `0001_init.sql` and `0002_workspace_auto_approve.sql`.
3. Add all variables from `.env.example` in **Vercel -> Project Settings -> Environment Variables**.
4. Deploy. Members only need the resulting URL and their own AI configuration.

---

## Project Layout

```text
.
├── src/
│   ├── app/            # Pages (/, /search, /research, /makalah, /projects, /chats, /reader/[id],
│   │                   # /upload, /settings, /admin, /login, /register, /forgot-password, /reset-password)
│   │                   # and API routes (/api/ai/*, /api/auth/*, /api/documents/*, /api/rag/*,
│   │                   # /api/research/*, /api/search/web, /api/workspaces/*)
│   ├── components/     # Topbar, Sidebar, MobileShell, DocDetail, UploadFlow, BulkUploadFlow,
│   │                   # QuickAddByIdentifier, ScannedPdfOcrCard, DuplicateMergerModal,
│   │                   # reader/PdfCanvasViewer, ChatHistoryPanel, MakalahHistoryPanel, etc.
│   ├── contexts/       # SessionContext, InferenceContext, ChatContext, MakalahContext
│   └── lib/
│       ├── api.ts      # Client API facade backed by src/lib/api/*
│       ├── ai/         # OllamaProvider, CloudProvider, provider registry, AES-GCM keys
│       ├── search/     # Anti-AI-Slop webFilter.ts & multi-provider search fetchers
│       ├── rag/        # Hybrid retrieval, Okapi BM25, RRF fusion, reranking
│       ├── wb/         # Library, Ask/Summarize/Matrix/Synthesis, Makalah, Ingest, Export, Projects
│       ├── research/   # Ask stream orchestration, summarization helpers, call budgets
│       ├── ingestion/  # Parsing, OCR, dedup, classification, chunking, web worker client
│       ├── importing/  # BibTeX/RIS/EndNote/CSL-JSON parsers & Zotero Web API v3 client
│       ├── export/     # Pure-JSZip native OpenXML .docx generator
│       ├── citations/  # citeproc-js engine & serializers
│       └── legal/      # Court/case/statute parsing & citation graphs
├── supabase/
│   └── migrations/     # 0001_init.sql, 0002_workspace_auto_approve.sql
├── public/csl/         # Vendored CSL citation styles & locale
├── .env.example
├── README.md
└── DETAILS.md          # Complete architecture and behavior reference
```

For full technical internals, RLS policies, and module behavior, see [DETAILS.md](DETAILS.md).
