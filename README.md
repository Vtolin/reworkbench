# Local Academic Research Workbench

A privacy-oriented RAG system for searching, analyzing, comparing, and summarizing academic documents entirely on-device. Hybrid BM25+vector retrieval, cross-encoder re-ranking, section/pinpoint/year/jurisdiction extraction, whole‑document summarization, cross‑source comparison with conflict detection, toggleable thinking mode (Ollama `think=true`), conversation memory, and an automatic research trail.

> Mendeley-like library where the collection itself can be reasoned over — local-first, Ollama-only, SQLite is source of truth, no cloud DB.

## Quick start (5 minutes, read this first)

1. Install Ollama, then pull the four models (~23 GB total): `nomic-embed-text` (274 MB), `qwen3.5:4b` (3.4 GB), `qwen2.5:7b` (4.7 GB), `gemma4:26b-a4b-it-qat` (15 GB). Details in Setup §4 below.
2. `pip install -r requirements.txt`, then `cd web && npm install && cd ..`.
3. Run `.\run.ps1` (or `start_backend.ps1` + `npm run dev` in `web/`). Open http://127.0.0.1:3000.
4. Upload 2–3 documents (Library → Upload, or drop files in `pfolder/` — see "Adding documents" below), **wait for indexing to finish** (see expectations), then ask a question in Research → Ask.

What is this for: a personal, fully-offline research library — store papers, ask questions with cited answers, compare sources, build literature matrices, and manage Реферат-style evidence for projects. What it is not: multi-user software. There are no accounts; anyone reaching the backend port owns the library, so keep it on `127.0.0.1` (the default).

## Setup

### Prerequisites
- **Python 3.9+** (tested with 3.13)
- **Ollama** (download from [ollama.com](https://ollama.com)) — all stages run on Ollama; no LM Studio required.
- **Node 18+** for the web UI (Node 24 available)
- **~25 GB free disk** for models (see §4) plus room for your library. **GPU strongly recommended**: embedding + reranking run on CPU acceptably, but the 26B chat/synthesis at usable speed wants ≥6 GB VRAM (tested on an RTX 4050 6 GB + 24 GB RAM, ~20 tok/s).
- **At least 16GB VRAM recommended for the 26B model** — adjust models or `chat_num_ctx` in `config.py` / Settings if you have limited resources. (note: i ran it on an rtx 4050 6gb with 24gb ddr5 5600 ram and it runs up to 20tok/s)

### 1. Clone or download the repository
```bash
git clone https://github.com/Vtolin/Local-Academic-Research-Assistant/blob/main/README.md
cd local-academic-research-assistant
```

### 2. Choose your Python environment

#### Option A: Virtual environment 
```bash
python -m venv venv
source venv/bin/activate        # Linux/macOS
# or
venv\Scripts\activate           # Windows
```

#### Option B: System Python 
Skip the venv commands and install packages globally.

### 3. Install dependencies
```bash
pip install -r requirements.txt
cd web && npm install && cd ..   # for the web UI
```

### 4. Configure Ollama models

All stages run on Ollama. Default routing (`config.py`):

| Stage | Model | Purpose |
|---|---|---|
| `RAG` | `gemma4:26b-a4b-it-qat` | Question answering over retrieved chunks (Research → Ask) |
| `MAP` | `qwen3.5:4b` | Batch fact extraction (summarization step 1) |
| `REDUCE` | `qwen2.5:7b` | Consolidating/deduplicating extract batches (step 2) |
| `SYNTHESIS` | `gemma4:26b-a4b-it-qat` | Final narrative summary (step 3) |
| `DOC_TYPE` | `qwen3.5:4b` | Tiny document-type classification call |
| `EMBED` | `nomic-embed-text` | Vector embeddings |

A summarization run therefore extracts with `qwen3.5:4b`, consolidates with `qwen2.5:7b`, then hands off to `gemma4:26b-a4b-it-qat` for the final synthesis — all on the same Ollama daemon (`http://localhost:11434`).

Pull the models (or set the tags to models you already have):
```bash
ollama pull nomic-embed-text
ollama pull qwen3.5:4b
ollama pull qwen2.5:7b
ollama pull gemma4:26b-a4b-it-qat 
```

> If you are on a GPU‑poor machine, reduce model sizes (e.g., `gemma4:26b-a4b-it-qat` → `gpt-oss 20b/qwen2.5:7b` in `config.py` or via Settings → Chat, and lower `chat_num_ctx` from 32768 to 8192).

Thinking mode: the Research → Ask chat exposes a **Thinking** toggle. When on, the app sends `think=true` to Ollama and injects a `<think>` prompt so the model reasons step-by-step. It is always available because the stack is Ollama-only.

### 5. Prepare your document library
Create a folder named `pfolder` in the project root (or change `DOC_FOLDER` in `config.py`). Place your documents inside (subdirectories are supported).

Supported formats (`SUPPORTED_DOC_EXTENSIONS` in `config.py`): `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.txt`, `.md`, `.csv`, `.tsv`, `.html`, `.htm`, `.rtf`.

```bash
mkdir pfolder
# copy your documents into pfolder/
```

> Non‑PDF formats have no real page breaks: their text is split into ~3000‑character pseudo‑pages (`PSEUDO_PAGE_CHARS`), so page filters still work, just per segment. Section labels come from each format's structure (docx headings, sheet names, slide numbers, markdown `#` headings).

### 6. Adding documents — two paths, pick per file

- **Web Upload (recommended for most files):** Library → Upload → drop a file → review the AI-proposed metadata → **Accept & Index**. The file lands in content-addressed storage (`research_workbench/data/documents/ab/cd/<sha256>.ext`) and is embedded immediately. The Accept step shows "Analyzing…" with no progress bar — a book can take many minutes; leave the tab open. If it reports an indexing error, the row is kept with `error` status: delete it and re-upload once Ollama is healthy (re-uploading without deleting hits the duplicate guard).
- **`pfolder/` watch-folder (good for bulk drops):** copy files into `pfolder/` while the backend runs; within ~30 s they are auto-embedded and appear in the Library. The one-time `import_legacy.py` script (already run here) only created SQLite rows for a pre-existing `pfolder/` corpus — new drops go through the full pipeline automatically.

Both paths feed the same Chroma index + SQLite library; use either freely.

### 7. First-run expectations (read before reporting slowness)

- **Indexing is the slow part.** Every chunk is embedded locally: a 10-page paper takes ~a minute, a 300-page book can take 30+ minutes on a 6 GB card. There is no per-chunk progress in the Upload UI (the backend terminal shows batch progress). Plan bulk imports accordingly — e.g. overnight.
- **First question after idle is slow.** Ollama unloads idle models after ~5 min; the next Ask/Summarize reloads them (the 15 GB 26B takes a while, mostly into system RAM on small GPUs). Subsequent questions are fast until idle again.
- **First rerank downloads ~500 MB** from Hugging Face (`RERANK_CACHE_DIR`). Needs internet once; afterwards it is cached and offline-safe.
- **Summarizing a book takes minutes** (dozens of extraction batches + 26B synthesis). The Research → Summarize view streams live stage progress (`Mapping batch 12/66 → Reducing → Synthesizing`) so you can watch it work.

---

## Running

### CLI only
```bash
python main.py
```

On first run, it will:
- Detect supported documents in `pfolder`
- Chunk and embed them using `nomic-embed-text`
- Build a persistent Chroma vector store in `chroma_db/`
- Load a BM25 index (rebuilds on‑the‑fly)

Once ready, you’ll see a prompt. Type `reindex` if you add/remove documents later (the system also automatically syncs new files on startup).

### Web UI (recommended) — Library, Search, Research, Projects, Reader

**Stack:** Next.js 16 (TypeScript + Tailwind) + FastAPI — library table + detail drawer, collections sidebar, citation panel, reader, and projects, all on top of the same Python engine.

**Option A — one click**
```powershell
# from project root mlra/
.\run.ps1
# opens:
#   Library: http://127.0.0.1:3000
#   API:     http://127.0.0.1:8000/docs  &  /api/health
```

**Option B — two terminals**
```powershell
# terminal 1 — backend
.\venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload

# terminal 2 — frontend
cd web
npm run dev   # http://127.0.0.1:3000
```

Requirements for Ask/Summarize/Compare: Ollama must be serving (`ollama serve`, `http://localhost:11434`). Library CRUD, Search, and Upload preview work offline without any model.

Env: `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`).

---

## Usage

### CLI prompts

| Input | What happens |
|---|---|
| `What is the main methodology?` | Focused hybrid search |
| `What does page 5 say?` / `compare page 10 and page 23` | Exact page(s), no search |
| `summarize journal5` | Auto‑detected file reference, answered as a normal question scoped to that file |
| `filter: filename.pdf \| your question` | Explicit file scope – also accepts a year (`filter: 2021 \| ...`) or jurisdiction (`filter: australia \| ...`) |
| `broad: your question` | Wide, diversity‑optimized sweep |
| `summarize: journal5` / `summarize: 2021` | Whole‑document summary (stuffing or map‑reduce) |
| `summarize: journal5 html` / `summarize: journal5 pdf` | Same summary, plus a styled HTML/PDF report written to `summaries/` |
| `compare: doc1, doc2 \| your question` | Separate per‑source retrieval + conflict‑aware synthesis |
| `memory on` / `memory off` / `forget` | Toggle or clear conversation history |
| `export citations` | Write every source cited this session to `citations_export.txt` |
| `reindex` | Rebuild the index from scratch |

### Web UI pages

- **/** Library — table (title, year, type, collections, tags), filters (q, year, type, collection/tag via query param), quick add collection/tag, detail drawer (Metadata / Ask this document / Citations / Notes). Sidebar shows live counts + collections/tags.
- **/search** — single search box with global spec + structured filters, grouped results, passages from hybrid retrieval.
- **/upload** — drag-drop + preview card (AI proposes, human confirms) with duplicate and collection suggestion. Uploads stream with a 150 MB cap; previews expire after 30 min (max 20 pending). If the PDF carries a DOI (or the title matches a published record), the backend queries **OpenAlex** and shows a metadata verification card — source, match confidence, alternative matches, and **Accept / Edit / Reject** — so external metadata never silently overwrites what you typed.
- **/research** — Ask (scoped, **Thinking** toggle = Ollama `think=true`, streaming, hybrid source modes, per-chat conversation memory), Compare (≥2 docs, per-source retrieval, conflict-aware), Summarize (map→reduce→synthesis with `gemma4:26b-a4b-it-qat`, auto-exports a verified PDF unless unticked), **Matrix** (literature matrix → CSV/XLSX/MD), **Synthesis** (cross-paper agreement/gaps), Research trail (expandable provenance). Footer shows current `model • num_ctx`.
- **/projects** — list + create + detail (`/projects/[id]`) with scoped Ask, evidence cards, **claims with supports/contradicts/mentions evidence links**, notes, queries.
- **/reader/[id]** — PDF iframe + highlight palette + notes → SQLite `annotations` (document_id, page, offsets, text, note, color, tags, project/claim links).
- **/settings** — **Chat — Research Ask (26B)** (model tag, `num_ctx`, safety margin, temperature, `num_predict` via `PUT /api/config`), **Citation** (default CSL style, fetch from the CSL repository, add custom CSL XML), **Import/Export** (BibTeX/RIS/EndNote XML/CSL-JSON), plus embeddings/thresholds, strict offline toggle, storage info, health + effective config dump, backup (SQLite online backup, keeps the 10 newest).

Try in Research: ask a scoped question, toggle **Thinking** for hypotheses, switch `Broad` or `Hybrid` modes, and inspect sources.

---

## Configuration

All tunable parameters live in `config.py`. Key settings:

- **Storage:** `PERSIST_DIR`, `DOC_FOLDER`
- **Chunking:** `CHUNK_SIZE`, `CHUNK_OVERLAP`
- **Retrieval counts:** `SIMILARITY_K`, `BM25_K`, `HYBRID_TOP_N`, `BROAD_K`, etc.
- **Cross‑encoder:** `RERANK_MODEL` (default `ms-marco-MiniLM-L-12-v2`) – first run will download from Hugging Face (~500 MB).
- **Model routing (Ollama-only):** each stage is its own model tag — `RAG_MODEL`, `MAP_MODEL`, `REDUCE_MODEL`, `SYNTHESIS_MODEL`, `DOC_TYPE_MODEL`, `EMBED_MODEL`. All talk to the same Ollama daemon.
- **Ollama context & generation:** `NUM_CTX` (default `32768` for the 26B chat), `CTX_SAFETY_MARGIN`, `GENERATION_TEMPERATURE`, `RAG_NUM_PREDICT`, plus per-stage `MAP_NUM_CTX` / `REDUCE_NUM_CTX` / `SYNTHESIS_NUM_PREDICT`. Per-request `num_ctx` controls the KV-cache for that call.
- **Chat tuning without editing files:** the **Settings → Chat — Research Ask (26B)** UI exposes `chat_model`, `chat_num_ctx`, `chat_ctx_safety_margin`, `chat_temperature`, `chat_num_predict`. Values are stored in SQLite (`settings` table) and merged by `config.get_chat_config()`; they take effect on the next question (no restart). Also reachable via `GET /api/config` / `PUT /api/config`.
- **Automated metadata fetching:** on upload the ingestion pipeline extracts the DOI and queries **OpenAlex** (`core/metadata/providers.py`, pluggable `MetadataProvider` interface — Crossref/PubMed can be added later). No DOI → title search + fuzzy matching → candidate list. Strict offline mode skips all network providers and falls back to the deterministic local extractors. Every proposal carries `metadata_source` / `metadata_confidence` and is stored as `metadata_verified` only after you accept it in the UI. Normalized fields (`volume`, `issue`, `pages`, `publisher`, `abstract`) go into typed columns; provider-specific extras go into `citation_metadata` JSON; a first-class `sources` table keeps the bibliographic record separate from the document row.
- **CSL citation engine (backend citeproc-py):** one shared engine renders citations for the UI, CLI and exported reports — no per-client duplicate logic. Ships APA 7, Chicago author-date, MLA, OSCOLA, Bluebook Law Review, Cite Them Right (Harvard), and AGLC, and supports the CSL ecosystem: fetch any style from the official CSL repository by id, or paste your own CSL XML (Settings → Citation). Rendered per-document in the Cite drawer; whole-library bibliography export at `/api/export/bibliography?style=…`.
- **Import/export:** import BibTeX / BibLaTeX / RIS / EndNote XML / CSL-JSON (Settings → Import/Export, auto-detected; duplicates skipped by DOI/title); export BibTeX, RIS, CSL-JSON, or a CSL-rendered bibliography — the Zotero → RIS → here → BibTeX → LaTeX loop works.
- **Browser capture:** minimal MV3 extension in `browser-extension/` — one "Save to Local Workbench" action sends the current page's URL/DOI/title to `POST /api/capture`, which resolves metadata via OpenAlex, downloads the PDF when the URL points at one (http(s) only, streamed with a 150 MB cap, non-PDF content refused, link-local hosts blocked), and files the record in the library.
- **Literature matrix:** Research → matrix — select documents and build a Paper/Method/Dataset/Findings/Limitations table via the local model; export CSV, XLSX or Markdown.
- **Saved searches:** save a query (plus structured filters) by name in Search and re-run it later as the library grows.
- **Related documents:** each document has labeled relationships — citation (from the legal citation graph), shared authors, shared topics (tags/collections), and semantic similarity — never collapsed into one unexplained score.
- **Claim → evidence graph:** projects hold first-class claims; each claim links sources with an explicit `supports / contradicts / mentions` edge (plus locator), so "SUPPORTED BY A (p.17), CONTRADICTED BY C (p.41)" is queryable structure, not prose.
- **Structured annotations:** highlights/notes now carry tags and links to a project or claim (`tags_json`, `project_id`, `claim_id`).
- **Citation-aware reader:** the reference list (`[23] Author…`) is extracted from the document and fuzzy-matched against the library, so a cited work opens directly.
- **Legal intelligence:** deterministic extraction of case metadata (court, case number, parties, decision date) and a citation graph of cited cases / statutes / Pasal (`/api/library/documents/{id}/legal/refresh`, `/api/cases/citing?case_number=…`); plus LLM-based putusan analysis (facts, issues, legal basis, arguments, considerations, ratio decidendi, obiter dictum, holding).
- **Structured extraction & cross-paper synthesis:** one-click document analysis with a configurable checklist (paper: methodology/research question/dataset/findings/limitations/contributions/key citations/future work; legal: the putusan sections), and multi-document synthesis answering agreement / disagreement / research gaps / claims-by-support.
- **Tests:** `python -m unittest discover -s tests` — metadata providers (DOI hit/miss, ambiguous title, offline fallback), storage (migration, round-trip, never-overwrite), CSL engine, import parsers, legal extraction; plus `tests/smoke_endpoints.py` for the HTTP layer. Note: the smoke test runs against your **real local database** (it imports a test reference, then deletes it and itself cleans up) — don't run it mid-demo if stray rows would confuse you.

Data layout (created on first run):
```
research_workbench/
  data/
    library.db
    documents/ab/cd/<sha256>.pdf
    attachments/ thumbnails/ chroma/ indexes/ exports/ backups/ cache/
  config/
chroma_db/          # vector store
pfolder/            # legacy corpus (auto-imported once via import_legacy.py)
summaries/          # exported HTML/PDF reports
```

---

## Architecture

```
Web UI (Next.js 16 App Router)  ─┐
  Library / Search / Research ───┼─→ FastAPI (server.py) : Library mgmt, ingestion, retrieval
  Projects / Reader / Upload ────┘     → Storage: SQLite (library.db) is source of truth
                                       → Filesystem (documents/ab/cd/<sha>.pdf)
                                       → Chroma (chroma_db/ + BM25)
                                       → Research Engine: retrieval.HybridIndex, generation.get_chat_config, summarization, research_trail, llm_client (Ollama-only)
CLI (main.py) ────────────────────────→ same engine (pfolder/ + chroma_db/)
```

New modules for the workbench:
- `storage/sqlite.py` — full schema (documents, collections, document_collections, authors, document_authors, tags, document_tags, annotations, notes, research_projects, research_project_documents, research_queries, evidence_items, settings). `settings` now also stores `chat_*` overrides for the 26B chat.
- `storage/filesystem.py` — content-addressed `documents/ab/cd/<sha256>.ext`.
- `core/library/{documents,collections,tags}.py` — CRUD, hydrated with joins.
- `core/ingestion/{deduplication,classifier}.py` — SHA-256 → DOI → normalized title → author/year → fuzzy title (no LLM).
- `server.py` — FastAPI, CORS, 30+ endpoints (see `/docs`).
- `config.py` — Ollama-only routing (`gemma4:26b-a4b-it-qat` etc.) + `get_chat_config()` that merges DB overrides.
- `llm_client.py` — Ollama-only `chat`/`chat_stream`/`make_embeddings`.
- `web/` — Next.js 16, Tailwind 4, App Router.

No PostgreSQL/Redis/Docker — SQLite + filesystem + Chroma + BM25 only. Existing `ingestion.py`/`retrieval.py` reused.

---

## API Endpoints (see http://127.0.0.1:8000/docs)

- `GET /api/health`, `GET /api/config` (effective chat config), `PUT /api/config` (tune `chat_model`/`chat_num_ctx`/...), `GET /api/library/stats`
- `GET /api/library/documents`, `PATCH /api/library/documents/{id}`, `DELETE ...`, `POST .../collections`, `POST .../tags`, `GET .../file`
- `POST /api/ingest/preview` (multipart) → `{temp_id, extracted, duplicates, suggested_collection, decision}`; `POST /api/ingest/confirm` → persists + embeds + indexes
- `GET /api/library/collections`, `POST ...`, `GET /api/library/tags`, `POST ...`
- `GET /api/search?q=...` — grouped Documents/Passages/Authors/Collections/Tags, supports `author:"..." year:2024 tag:... collection:"..."`
- `POST /api/research/ask` (scoped by `document_ids` or `collection_id` or `project_id`, `broad` + `thinking` flags, `session_id` for per-chat memory — defaults to `"default"`), `POST /api/research/ask/stream` (SSE), `POST /api/research/summarize`, `POST /api/research/compare`, `GET /api/research/trail`
- `GET /api/research/memory?session_id=...`, `POST /api/research/memory/clear?session_id=...` (per-chat conversation memory; no `session_id` = default session)
- `GET /api/research/projects`, `POST ...`, `GET .../{id}`, `POST .../{id}/documents`, `POST .../{id}/evidence`
- `GET /api/library/documents/{id}/annotations`, `POST ...`, `GET /api/citations/{id}`, `GET /api/export/bibtex`, `POST /api/backup`, `GET/PUT /api/settings`

---

## Important Notes

- **Deployment scope: local single-user.** The backend binds `127.0.0.1:8000`, has no login/accounts, and CORS only allows the local frontend (`localhost:3000`/`127.0.0.1:3000`). It is ready for daily personal use on your own machine — do not expose the port to a network: anyone who can reach it can read, add, and delete your entire library. Backups stay on disk (`research_workbench/data/backups/`, 10 newest kept); copy one elsewhere if the library matters to you.

- **Indonesia legal focus:** jurisdiction detection covers the Indonesian court system (PN, PT, MA, MK, PTUN, etc.) in both Bahasa Indonesia and English; pinpoint detection handles `Pasal`/`ayat` citations; legal documents are summarized along the putusan structure (Duduk Perkara → Pokok Perkara → Dasar Hukum → Pertimbangan Hukum → Amar Putusan) with exact Pasal/ayat citations preserved; and the verbatim facts section has a **Legal Citations (Pasal / UU / Putusan)** category.
- **Ingestion circuit breakers:** every page is scored for readability before embedding — garbage pages are dropped, and a document that is mostly garbage is skipped entirely. Consecutive embedding failures trip a per-document breaker. Multi-column PDF pages are re-ordered column-by-column before chunking.
- **Tables:** summaries append an `Extracted Tables (Verbatim)` section via PyMuPDF's table finder — pipe-separated rows with page numbers, capped by `TABLE_MAX_ROWS_PER_TABLE`/`TABLE_MAX_TOTAL_ROWS`.
- **Human-readable output:** synthesis writes equations/statistics in plain text and natural-language attribution; `output_cleanup.py` converts LaTeX math to readable Unicode and strips tag residue.
- **Dates:** years are extracted as-written.
- **Ollama must be running** before Ask/Summarize/Compare — default `http://localhost:11434` (`ollama serve`). Library CRUD and Search work offline.
- **Switching models:** if you change `EMBED_MODEL`, run `reindex`. Chat-model / context changes (`chat_model`, `chat_num_ctx` via Settings or `config.py`) take effect on the next question, no reindex needed.
- **Citation format:** style‑agnostic (`filename, Page N, ¶ 42 (Section; Jurisdiction; Year)`). Change in `research_trail.py` (`format_citation`).
- **Memory usage:** the 26B model (`gemma4:26b-a4b-it-qat`) is heavy. Lower `chat_num_ctx` (e.g., `8192`) in Settings or `config.py`, or point `SYNTHESIS_MODEL` at a smaller tag (e.g., `qwen2.5:7b`) if you hit OOM.

---

## Troubleshooting

| Issue | Likely fix |
|-------|------------|
| `ModuleNotFoundError` | Activate the venv and `pip install -r requirements.txt`. |
| `Ollama connection refused` | Ensure Ollama is running (`ollama serve`) and reachable at `http://localhost:11434`. Try `ollama list` and `curl http://localhost:11434/api/tags`. |
| Embedding errors during indexing | Some PDFs may contain malformed characters. The system skips bad chunks; check warnings. |
| `Error finding id` during retrieval | Chroma/HNSW issue when requesting more results than available — reduce `SIMILARITY_K` or `BROAD_K`. |
| `flashrank` download fails | Check internet/proxy. Download manually and point `RERANK_CACHE_DIR` to the folder. |
| Out‑of‑memory (OOM) | Lower `chat_num_ctx` in Settings → Chat (e.g., `8192`), lower `MAP_NUM_CTX`/`REDUCE_NUM_CTX` in `config.py`, or use smaller models / Ollama CPU offloading. |
| Port already in use (`8000`/`3000`) | Another instance is running (check for a stray `uvicorn`/`node` process), or a previous `run.ps1` didn't stop its servers — kill them and retry. `run.ps1` stops both on Enter. |
| Document stuck at `error` after upload | Ollama's runner wasn't reachable during embedding (common right after `ollama serve` starts). Confirm health with `ollama ps`, delete the row, re-upload. The file itself was stored fine — only indexing needs redoing. |
| Slow first answer, then fast | Normal: idle models unload after ~5 min and reload on demand (see First-run expectations §7). |
| `Preview expired or not found` on confirm | Previews expire after 30 min (or if the server restarted) — re-upload the file. |
| `File too large (max 150MB)` | Split the file or raise `_MAX_UPLOAD_BYTES` in `server.py`. |

---

## Files

| File | Responsibility |
|---|---|
| `config.py` | All tunable constants + `get_chat_config()` (DB overrides for 26B chat) |
| `query_understanding.py` | Intent classification (page/broad/summarize/compare/factual) |
| `filters.py` | Filename, year, and jurisdiction filter resolution |
| `heading_detection.py` | Section heading detection for PDFs |
| `document_loaders.py` | Loaders for non‑PDF formats + format dispatcher |
| `metadata_extraction.py` | Publication‑year extraction |
| `jurisdiction_extraction.py` | Jurisdiction/court extraction (Indonesia-focused) |
| `pinpoint_detection.py` | Pinpoint detection (¶ N, Pasal N ayat (M)) |
| `ingestion.py` | Document loading, chunking, metadata tagging, vector store sync |
| `retrieval.py` | Hybrid retrieval, direct/whole‑doc fetch, cross‑encoder rerank |
| `llm_client.py` | Ollama-only chat + embeddings (`chat`, `chat_stream`, `make_embeddings`) |
| `generation.py` | Context assembly, per‑intent prompts, generation calls (reads `get_chat_config`) |
| `summarization.py` | Whole‑document summarization (stuff / map‑reduce, all Ollama) |
| `conversation.py` | Bounded, toggleable Q&A memory (thread-safe; server keeps one per chat `session_id`) |
| `research_trail.py` | Auto‑logged research trail + citation export |
| `main.py` | CLI orchestration |
| `server.py` | FastAPI backend (`/api/config` exposes effective chat config, `PUT /api/config` tunes 26B; single shared Chroma client, per-chat memory sessions, CORS limited to the local frontend) |
| `storage/sqlite.py` | SQLite source of truth + `settings` KV (incl. `chat_*` overrides) + idempotent migrations |
| `core/metadata/providers.py` | Pluggable metadata providers (OpenAlex + local fallback) |
| `core/library/sources.py` | First-class `sources` entity (bibliographic record per document) |
| `core/citations/engine.py` | CSL citation engine (citeproc-py) + style manager |
| `core/importing/parsers.py` | BibTeX / RIS / EndNote XML / CSL-JSON import+export |
| `core/legal/extraction.py` | Deterministic case metadata + legal citation graph extraction |
| `core/research/analysis.py` | Literature matrix, structured extraction, cross-paper synthesis, legal analysis |
| `browser-extension/` | Minimal MV3 "Save to Local Workbench" capture extension |
| `tests/` | unittest suite + `smoke_endpoints.py` (HTTP layer) |
| `web/` | Next.js 16 frontend (Library/Search/Research/Projects/Reader/Settings) |

---

## Next Steps / Customisation

- **Chat model / context:** use **Settings → Chat — Research Ask (26B)** to change `chat_model` / `chat_num_ctx` / `chat_temperature` without editing files, or edit `config.py` defaults directly.
- **Citation style:** Edit `research_trail.py` → `format_citation` to implement Bluebook, OSCOLA, AGLC, etc.
- **Add more jurisdictions:** Extend the pattern table in `jurisdiction_extraction.py`.
- **Prompt tuning:** Adjust system prompts in `generation.py` and `summarization.py`.

---

## Scripts

- `import_legacy.py` — one-time import of `pfolder/` into SQLite (already run).
- `run.ps1` — starts both servers, waits for health, prints URLs, stops on Enter.
- `start_backend.ps1` — backend only.
- `web/README.md` — frontend dev notes (`npm run dev`, `NEXT_PUBLIC_API_URL`).
- `browser-extension/` — load unpacked in Chrome/Edge Developer mode (see its README).

## Roadmap status

| Phase | Feature | Status |
|---|---|---|
| P0 | OpenAlex metadata + verification UI | ✅ |
| P0 | CSL citation engine + style manager | ✅ backend citeproc-py |
| P0 | BibTeX/BibLaTeX/RIS/EndNote XML/CSL-JSON import/export | ✅ |
| P1 | Browser capture extension | ✅ minimal MV3 |
| P1 | Literature matrix | ✅ + CSV/XLSX/MD export |
| P1 | Saved searches | ✅ |
| P1 | Related documents (labeled relations) | ✅ |
| P1 | Better annotations (tags + project/claim links) | ✅ |
| P2 | Claim → evidence graph | ✅ supports/contradicts/mentions |
| P2 | Citation graph | ✅ legal case/statute/Pasal edges |
| P2 | Structured extraction + cross-paper synthesis | ✅ |
| P3 | Legal intelligence (case metadata, reasoning, citation graph) | ✅ |
| — | Collaboration / cloud sync | deferred |

---
