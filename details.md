# Local Academic Research Workbench — Complete Technical Details

> **Version:** 2026-09 (Ollama-only, 26B default: `gemma4:26b-a4b-it-qat`)
> **Stack:** Python FastAPI + Next.js 16 (TypeScript + Tailwind) + Chroma + BM25 + SQLite + Ollama
> **Principle:** Local-first, privacy-oriented, SQLite is source of truth, no cloud DB, no LM Studio.

---

## 1. Introduction

Local Academic Research Workbench is a local-first reference manager and AI research workbench that turns a document library into a searchable, evidence-linked research environment. It combines:

- **Reference management** (Zotero-like): collections, tags, authors, bibliographic metadata, CSL citation rendering, import/export.
- **Research engine** (RAG): hybrid BM25+vector retrieval, cross-encoder reranking, section-aware chunking, whole-document summarization, cross-source comparison.
- **Workspace** (projects, claims, evidence graph, annotations, legal intelligence): structured research beyond flat Q&A.

Unlike Mendeley/Zotero, its identity is broader: the library itself can be reasoned over by a local LLM (Ollama), with every answer carrying citations, evidence links, and a research trail.

**Design philosophy:** Finish the reference-manager foundation before adding more AI. The research engine is already advanced; the weakest layer was the bibliography/library layer — now rebuilt with OpenAlex metadata fetching, verification UI, CSL, import/export, and first-class `Source`/`Claim`/`Citation` entities.

---

## 2. System Overview & Architecture

### High-Level Data Flow

```
pfolder/  ──watch-folder (30s poll)──► Ingestion ──► Chroma (vector) + BM25 + SQLite
                                            │
Web UI (Next.js) ─────────────► FastAPI (server.py) ◄──────────── CLI (main.py)
  Library / Search / Research / Projects / Reader / Upload / Settings
                                            │
                           ┌────────────────┼────────────────┐
                           │                │                │
                        Library          Research          Reader
                           │                │                │
                      Collections       Projects         Annotations
                      Tags            Queries          Highlights
                      Metadata        Evidence         Notes
                      Dedup           Claims
                           │                │
                           └────────┬───────┘
                                    │
                             Research Engine
                                    │
                       ┌────────────┼────────────┐
                       ▼            ▼            ▼
                     BM25        Vector       Reranker (ms-marco-MiniLM-L-12-v2)
                       └────────────┼────────────┘
                                    ▼
                                 Ollama
                     (gemma4:26b-a4b-it-qat, qwen3.5:4b, qwen2.5:7b, nomic-embed-text)
                                    │
                       ┌────────────┼────────────┐
                       ▼            ▼            ▼
                  Extraction   Synthesis    Comparison
                       │            │
                       ▼            ▼
                 Evidence Graph ──► Research Trail ──► Citation Engine (CSL)
                       │                    │
                       ▼                    ▼
                    Claims              BibTeX / RIS / CSL-JSON / PDF / HTML
```

### Process Architecture

- **Single FastAPI process** (`uvicorn server:app --reload`) holds the RAG engine in-process — no separate Python worker, no Docker, no Redis.
- **Web UI** (`web/` Next.js App Router) talks to FastAPI via `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`). CORS is locked to the local frontend (`http://localhost:3000`, `http://127.0.0.1:3000`) with credentials — no wildcard.
- **CLI** (`main.py`) reuses the same `ingestion.py` / `retrieval.py` / `generation.py` / `summarization.py` modules, but with a REPL prompt (`Ask a question: `) and file-system `pfolder/` + `chroma_db/` paths. CLI memory is a single in-process `ConversationMemory` (single user, no sessions needed).
- **Watch-folder thread** (`server.py: _watch_pfolder_loop`) is a daemon thread started by the FastAPI `lifespan` context (replacing the deprecated `on_event` handlers), polling `DOC_FOLDER` every 30s and calling `ingestion.sync_new_files` under the shared Chroma write lock.
- **Deployment scope: local single-user.** The backend binds `127.0.0.1:8000` and has no authentication or per-user isolation — anyone who can reach the port can read, add, and delete the whole library. Ready for daily personal use on your own machine; do not expose the port to a LAN/WAN. Off-machine copies are the operator's job (`backups/` keeps the 10 newest local snapshots).

---

## 3. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| **Backend** | FastAPI + Uvicorn | Keeps Python RAG engine in-process without rewriting; 30+ endpoints at `/docs` |
| **Frontend** | Next.js 16 + TypeScript + Tailwind 4 (App Router) | Mendeley-like table + drawer + citation panel, better than plain HTML/JS |
| **Vector DB** | Chroma (`chroma_db/`) + `langchain-chroma` | Persistent, local, `similarity_search_by_vector` for related docs |
| **Lexical** | `rank_bm25` + `HybridIndex` (BM25_WEIGHT 0.4 / VECTOR_WEIGHT 0.6) | Hybrid narrow/broad retrieval, MMR diversity for broad |
| **Reranker** | `flashrank` / `ms-marco-MiniLM-L-12-v2` (~500 MB, cached in `rerank_cache/`) | Cross-encoder rerank after hybrid |
| **LLM + Embeddings** | Ollama-only (`llm_client.py`): `gemma4:26b-a4b-it-qat` (RAG + synthesis), `qwen3.5:4b` (map/doc-type), `qwen2.5:7b` (reduce), `nomic-embed-text` (embeddings) | Local, `num_ctx` per-request, `think=true` for reasoning models |
| **PDF** | `pymupdf` (text), `PyMuPDF.find_tables` (verbatim tables), `xhtml2pdf` + `markdown` (HTML/PDF export) | No Java/ghostscript |
| **Citation** | `citeproc-py` + `citeproc-py-styles` + vendored CSL styles (`core/citations/styles/`: apa, chicago-author-date, mla, oscola, bluebook-law-review, harvard-cite-them-right, aglc) | Backend CSL engine shared by UI/CLI/reports |
| **Import** | Custom parsers (`core/importing/parsers.py`) for BibTeX/BibLaTeX, RIS, EndNote XML, CSL-JSON | No `bibtexparser` dep, tolerant (skips malformed entries) |
| **Storage** | SQLite (`research_workbench/data/library.db` via `storage/sqlite.py`) — source of truth; filesystem `research_workbench/data/documents/ab/cd/<sha256>.ext` (content-addressed); Chroma + BM25 | No Postgres/Redis/Docker |
| **Browser** | MV3 extension (`browser-extension/` manifest.json + popup) | One action: `POST /api/capture` |
| **Node** | 18+ (24 available) | `web/` |

---

## 4. Data Model & Storage

### SQLite Schema (`storage/sqlite.py:16` `SCHEMA_SQL` + `_migrate_document_columns`)

**Documents — core library record**

| Column | Type | Notes |
|---|---|---|
| `title`, `original_filename`, `stored_path`, `file_hash` (UNIQUE) | TEXT | `file_hash` = SHA-256, `stored_path` = `documents/ab/cd/<sha256>.ext` |
| `doi`, `journal`, `volume`, `issue`, `pages`, `publisher`, `abstract` | TEXT | Normalized bibliographic fields |
| `year`, `page_count` | INTEGER |  |
| `jurisdiction`, `document_type` | TEXT | Indonesia legal focus; `legal`/`empirical`/`survey`/`thesis`/`general` |
| `citation_metadata` | TEXT (JSON) | Provider extras (OpenAlex `openalex_id`, `cited_by_count`, `court`, `case_number`, `url`) |
| `metadata_source`, `metadata_fetched_at`, `metadata_confidence` | TEXT/REAL | `openalex` / `local` / `import:ris` etc., `0.97` for DOI hit |
| `metadata_verified` | INTEGER DEFAULT 0 | 1 only after user Accept in verification UI |
| `ingestion_status`, `metadata_json` | TEXT | `ready` / `metadata_only` / `pending` + `{"text_snippet": ...}` |
| `volume`, `issue`, `pages`, `publisher` etc. added via `ALTER TABLE` migration for existing DBs |  | Idempotent `init_db()` |

**First-class entities (not just fields on Document)**

```sql
sources(id, document_id FK, source_type, doi, title, journal, volume, issue, pages, publisher, year, authors_json, court, case_number, decision_date, parties_json, judges_json)
claims(id, project_id FK, text, status, created_at)
citations(id, source_id FK, claim_id FK, support, locator, created_at) -- supports|contradicts|mentions
source_citations(id, source_id FK, cited_identifier, cited_source_id FK, kind, locator) -- case|statute|article; legal citation graph
saved_searches(id, name, query, filters_json, created_at)
annotations(id, document_id FK, page, selected_text, note, color, tags_json, project_id FK, claim_id FK)
```

**Other tables:** `collections`, `document_collections`, `authors`, `document_authors`, `tags`, `document_tags`, `notes`, `research_projects`, `research_project_documents`, `research_queries`, `evidence_items`, `settings` (KV: `strict_offline_mode`, `auto_organize_threshold_*`, `embedding_*`, `chat_*`, `citation_style`, `custom_csl_xml`).

**Filesystem**

- Static serving: `/files` mounts **only** `research_workbench/data/documents/` — `library.db`, `backups/`, `exports/` and `cache/` are never reachable over HTTP. (The reader uses `/api/library/documents/{id}/file`; `/files/ab/cd/<sha>.pdf` links keep working.)

```
research_workbench/data/
  library.db
  documents/ab/cd/<sha256>.pdf      # content-addressed
  backups/library_YYYYMMDD_HHMMSS.db
pfolder/                             # legacy CLI corpus (auto-imported once)
chroma_db/                           # vector store (persist_directory)
summaries/                           # exported HTML/PDF reports
rerank_cache/                        # cross-encoder model
```

**Migrations:** `init_db()` runs `executescript(SCHEMA_SQL)` (creates missing tables) + `_migrate_document_columns` (ALTERs missing columns) — additive, safe on live DBs, no data loss.

---

## 5. Core Engine

### 5.1 Ingestion (`ingestion.py`)

- **Loaders:** `document_loaders.py` dispatches by extension (`.pdf` via `heading_detection.py` + PyMuPDF, `.docx` via python-docx, `.xlsx` via openpyxl, `.pptx`, `.txt/.md/.csv/.html/.rtf`). Non-PDF pseudo-pagination: `PSEUDO_PAGE_CHARS = 3000` splits into "Page N" segments.
- **Quality gates:** `text_quality.assess_text_quality` per page; `PAGE_GARBAGE_THRESHOLD = 0.35` drops garbage pages, `DOC_GARBAGE_RATIO = 0.6` skips garbage-heavy docs; `EMBED_FAILURE_BREAKER = 10` stops embedding a broken source.
- **Multi-column PDFs:** `heading_detection.py` reorders blocks column-by-column.
- **Chunking:** `RecursiveCharacterTextSplitter(chunk_size=4700, chunk_overlap=880)`; chunk metadata: `source`, `page`, `section` (heading), `pinpoint` (¶), `chunk_index` (continued across `sync_new_files` batches via `max(chunk_index)+1`).
- **Tables:** `heading_detection.extract_pdf_tables` (`find_tables()`) → verbatim appendix capped at `TABLE_MAX_ROWS_PER_TABLE=80`, `TABLE_MAX_TOTAL_ROWS=400`.
- **Deduplication:** `core/ingestion/deduplication.py` priority: SHA-256 → DOI → normalized title → author+year → fuzzy title (difflib ≥0.85, reported at `check_duplicates`).
- **Classification:** `core/ingestion/classifier.py` keyword-based `classify_document_type` → `legal`/`empirical`/`survey`/`thesis`/`general` (0.45–0.92 confidence); `suggest_collection` matches existing collections by type/jurisdiction/year.
- **Sync:** `sync_new_files(vectorstore, doc_map)` — discovers `DOC_FOLDER` recursively (`_discover_documents`), diffs against `doc_map` keys, loads+splits+embeds only new files, `tag_chunks_with_pinpoints`, `add_documents` with continued `chunk_index`, returns bool for BM25 refresh.

### 5.2 Retrieval (`retrieval.py`)

- **HybridIndex:** `HybridIndex(vs)` holds `BM25Retriever` + `Chroma` vectorstore. `hybrid_retrieve(query, source_filter, broad=False)` → `BM25_K=10` + `SIMILARITY_K=10` → fusion (0.4 BM25 + 0.6 vector) → `HYBRID_TOP_N=8` (broad: `BROAD_K=15`, `BROAD_BM25_K=15`, `BROAD_TOP_N=12`, MMR diversity). `refresh_bm25()` rebuilds BM25 from current `vs.get()`.
- **Direct fetch:** `get_chunks_by_pages(vs, page_numbers, source_filter)` — exact page(s), no k cutoff, reranked only (no truncation).
- **Per-source:** `get_chunks_by_source(vs, source)` for summarization.
- **Rerank:** `hybrid.rerank(query, docs, top_n)` via `flashrank` cross-encoder (`ms-marco-MiniLM-L-12-v2`); download ~500 MB on first use, fallback to no rerank with warning.

### 5.3 Generation (`generation.py`)

- **Prompt selection by `Intent`** (`query_understanding.py` regex): `PAGE_SPECIFIC` (precise, quote-grounded), `BROAD` (synthesize across sources), `FACTUAL` (default), `COMPARE` (per-source labeled).
- **Context assembly:** `format_docs` labels every chunk `[file — Page N, pinpoint — Section]`; `format_compare_docs` groups under `=== Source: name ===` with explicit "no relevant excerpts" placeholder.
- **Generation via `llm_client.chat` (Ollama):** model/num_ctx/temperature from `config.get_chat_config()` (DB overrides for 26B chat). `thinking=True` → `think=true` flag + `<think>` prompt.
- **Hybrid source modes:** `hybrid_mode` (`off`/`low`/`medium`/`high`/`maximum`) replaces grounding instructions; `maximum` drops document context entirely.
- **Output cleanup:** `output_cleanup.sanitize_model_output` + `THINK_TAG_RE` stripping; `_extract_thinking` separates reasoning; `warn_if_context_too_large` heuristic (~4 chars/token vs `NUM_CTX - CTX_SAFETY_MARGIN`).

### 5.4 Summarization (`summarization.py`)

- **Pipeline:** fast MAP (`qwen3.5:4b`, `MAP_NUM_CTX=6144`, budget 55%) extracts bullets per batch → REDUCE (`qwen2.5:7b`, 60% budget, rounds until stagnant or 5 rounds or `FORCE_REDUCE_EXTRACT_THRESHOLD=8`) → SYNTHESIS (`gemma4:26b-a4b-it-qat`, `SYNTHESIS_NUM_PREDICT=5120`) writes final narrative + deterministic verbatim facts (percentages/dates/sample sizes/legal citations) + `extract_pdf_tables` appendix. `DOC_TYPE` classification (32-token call) picks structure per type (empirical → Purpose/Methodology…; survey → themes; legal putusan → Duduk Perkara…Amar Putusan).
- **Sentence splitting:** dependency-free regex with abbreviation list + initials pattern, O(n), newline-normalized before split.
- **Export:** `summary_export.export_summary_html/pdf` — markdown→HTML via `markdown`+tables, MathJax CDN for HTML, `xhtml2pdf` + Unicode TTF (Arial/DejaVu) for PDF; `SUMMARY_EXPORT_DIR=./summaries`.

---

## 6. LLM & Embeddings — Ollama-Only

**`config.py` routing (all `*_PROVIDER = "ollama"`):**

| Stage | Model | Purpose |
|---|---|---|
| RAG (Ask) | `gemma4:26b-a4b-it-qat` | Chat, `NUM_CTX=32768`, `CTX_SAFETY_MARGIN=800`, `GENERATION_TEMPERATURE=0.0`, `RAG_NUM_PREDICT=2048` |
| MAP | `qwen3.5:4b` | `MAP_NUM_CTX=6144`, `MAP_NUM_PREDICT=2688` |
| REDUCE | `qwen2.5:7b` | `REDUCE_NUM_CTX=12288`, `REDUCE_NUM_PREDICT=2048` |
| SYNTHESIS | `gemma4:26b-a4b-it-qat` | `SYNTHESIS_NUM_PREDICT=5120` |
| DOC_TYPE | `qwen3.5:4b` | `DOC_TYPE_NUM_CTX=4096` |
| EMBED | `nomic-embed-text` | `EMBED_PROVIDER=ollama` |

`get_chat_config()` merges DB `settings` (`chat_model`, `chat_num_ctx`, `chat_ctx_safety_margin`, `chat_temperature`, `chat_num_predict`) over defaults — Settings → Chat changes apply on next question, no restart. `THINKING_AVAILABLE = True` (Ollama).

**Ollama lifecycle (matters for first impressions):** the daemon unloads idle models after ~5 min (`ollama ps` shows the countdown), and the runner subprocess listens on an ephemeral localhost port. A cold Ask/Summarize/ingest pays a reload first — slow once, fast after. If the runner is still starting when an ingest's embedding burst hits, chunks fail fast with `tokenize … actively refused`, the per-document breaker trips, and the row lands in `ingestion_status='error'` (file stored fine — delete the row and re-upload, or re-index; the duplicate guard means re-upload without deleting 409s).

**`llm_client.py` (Ollama-only):** `chat(model, messages, num_ctx, num_predict, temperature, thinking)` → `ollama.chat(..., think=bool(thinking), options={temperature, num_ctx, num_predict})`; non-stream folds `message.thinking` into `<think>`; `chat_stream` yields deltas with `on_status("processing_prompt"/"generating")`; `make_embeddings(model, provider="ollama")` → `OllamaEmbeddings`.

Pull: `ollama pull nomic-embed-text qwen3.5:4b qwen2.5:7b gemma4:26b-a4b-it-qat`.

---

## 7. Features — Phased Roadmap (excl. collaboration/cloud sync)

### Phase 1 — Bibliographic Foundation (P0)

**Automated metadata fetching (`core/metadata/providers.py`)**

```
PDF → Extract DOI (10.\d{4,9}/…) ─┬─ DOI found ──► OpenAlex /works/doi:… (0.97 confidence)
                                  └─ No DOI ──► title search → fuzzy match (title_fuzzy_score) → candidates
                                                        │
Offline? strict_offline_mode=true ──► skip network, local fallback
Failure/timeout ──► degrade to LocalMetadataProvider (existing extractors)
```

- Provider architecture: `MetadataProvider` ABC (`fetch_by_doi`, `search_by_title`) → `OpenAlexProvider` (httpx, 10s timeout, injectable `AsyncClient` for tests), `LocalMetadataProvider`, `fetch_metadata()` orchestrator. Crossref/PubMed can be added later without touching callers.
- Normalized candidate: `{source, title, authors, year, doi, journal, volume, issue, pages, publisher, abstract, document_type, confidence, extras{openalex_id, cited_by_count, is_oa}}`. DOI cleaned (trailing punct, `https://doi.org/` prefix stripped).
- Wired into `POST /api/ingest/preview` (async) — preview returns `metadata_proposal`, `metadata_candidates`, `metadata_error`, `offline`; `_preview_store` keeps them until confirm.
- Tracking fields (never silently overwrite — only patch keys the user sent are applied in `core/library/documents.py` `update_document`): `metadata_source`, `metadata_fetched_at`, `metadata_confidence`, `metadata_verified` + typed columns `volume`/`issue`/`pages`/`publisher` + JSON `citation_metadata` + first-class `sources` row via `core/library/sources.py:sync_source_from_document` (present-keys-only on update, so a partial patch can't wipe stored fields).

**Metadata verification UI (`web/src/components/UploadFlow.tsx`)**

- Preview card: `Source: openalex ✓ • Match confidence: 97%` (or `Source: local extraction`), sentence preview of proposal (`title — journal (year)`).
- Candidate picker when multiple matches: dropdown of candidates sorted by confidence.
- **Reject — use local extraction** button reverts edit fields to `extracted` local values.
- Edit fields: title, authors (comma-separated), journal, volume, issue, pages, publisher, abstract, year, DOI, jurisdiction, type, collections; collections picker with existing + suggested. Confirm sends `citation_metadata: proposal.extras`, `metadata_source`, `metadata_confidence`, `metadata_verified: true`.

### Phase 2 — Real Citation Management (P0)

**CSL engine (`core/citations/engine.py`, backend `citeproc-py`)**

- `doc_to_csl_item(doc)` → CSL-JSON (`id`, `type` via `legal → legal_case`, `thesis → thesis`, else `article-journal`, `author[{family,given}]` from comma form, `issued`, `container-title`, `volume`/`issue`/`page`/`publisher`/`DOI`/`abstract`, plus `authority`/`number` from `citation_metadata` for legal).
- `render_citation(item, style_id)`, `render_bibliography(items, style_id)` via `CitationStylesStyle(path, locale='en-US')` + `CitationStylesBibliography(..., formatter.plain)` + `CiteProcJSON`; unknown style falls back to `apa`.
- Vendored styles (`core/citations/styles/`: `apa`, `chicago-author-date`, `modern-language-association`, `oscola`, `bluebook-law-review`, `harvard-cite-them-right`, `australian-guide-to-legal-citation`) from the official CSL repo; any other style fetchable on demand via `POST /api/citations/styles/fetch` (`GET https://raw.githubusercontent.com/.../{name}.csl` cached) + `POST /api/citations/styles/custom` (user pasted XML → `custom-user.csl`).
- `list_styles()` reads `<title>` from each `.csl`; `_KNOWN_STYLES` is curated — the app truthfully "supports the CSL ecosystem" without claiming 10k catalog.
- `bibtex_entry`, `ris_entry` for other formats.

**Citation style manager (Settings → Citation)**

- Card: default style dropdown (populated from `GET /api/citations/styles` → `{styles, default}`), `PUT /api/citations/styles/default` persists to `settings.citation_style`; fetch-by-id input; add-custom XML textarea. DocDetail Cite tab renders with the chosen style, falling back to plain.

### Phase 3 — Import/Export Ecosystem (P0)

**Parsers (`core/importing/parsers.py`)**

- `parse_bibtex` — handles nested braces, `author = {… and …}`, `journal`/`journaltitle`/`booktitle`, `number` vs `issue`, `pages --` → `-`; collections from `groups`/`collection`/`keywords` (JabRef/Zotero).
- `parse_ris` — `TY`→collection boundary, `AU`/`TI`/`PY`/`DO`/`JO`/`VL`/`IS`/`SP`+`EP`→pages, `KW`/`DB`→collections.
- `parse_csl_json` — `author[{family,given}]` → `given family`, `issued.date-parts` → year, `container-title`→journal, `collection-title`→collections.
- `parse_endnote_xml` — `<record><title><authors><year>` etc., plus `group`/`collection`→collections.
- `detect_format` + `parse_references` try-each fallback; serializers `docs_to_bibtex/ris/csl_json` via engine.

**Endpoints**

- `POST /api/import/refs` (`{text, format?}`) — auto-detect, dedupe by DOI/lower(title), `create_document` with `ingestion_status="metadata_only"`, preserve collections (create `collections` on demand + `document_collections` links).
- `POST /api/import/file` (multipart) — One-Click Importer file drop (`Settings → Import/Export` file picker → `api.importFile`), same preservation + copies linked PDFs when `file` field resolves.
- `GET /api/export/refs?format=bibtex|ris|csl-json&ids=` and `GET /api/export/bibliography?style=apa&ids=` (CSL-rendered plain text).

**UI:** Settings → Import/Export card (file picker + paste textarea + format select + download buttons for BibTeX/RIS/CSL-JSON/bibliography).

### Phase 4 — Browser Capture (P1, minimal)

- `POST /api/capture` (`{url, doi?, title?}`) — `fetch_metadata` + best-effort PDF download when the URL path ends with `.pdf`: http(s) only, ≤3 redirects, host must resolve, link-local `169.254.0.0/16` refused, non-PDF content-types refused, body streamed with a 150 MB cap (10s connect / 60s read) → `save_uploaded_file` + `create_document` (or metadata-only `{title}.ref` record when no PDF); stores `citation_metadata.url`.
- Extension `browser-extension/` (MV3): `manifest.json` (activeTab + host_permissions for `127.0.0.1:8000`), `background.js` (service worker pipes to `/api/capture`), `popup.html`/`popup.js` (pre-fills DOI via `DOI_RE` on tab URL, editable title/DOI, Save button; shows saved id + `downloaded_pdf` + metadata source).

### Phase 5 — Research Workspace

**Literature matrix (`core/research/analysis.py:literature_matrix`, `POST /api/research/matrix` + `/api/research/matrix/export`)**

- One row per doc: `{paper, year, method, dataset, findings, limitations}` via `SYNTHESIS_MODEL` JSON extraction (STRICT JSON prompt, 28k chars/doc). Export via `POST /api/research/matrix/export` (`{rows, format: csv|md|xlsx}`) — CSV via `csv.DictWriter`, MD via `|` table, XLSX via `openpyxl` `Workbook`.
- UI: Research → matrix mode — doc picker (pill buttons), Build matrix, table (Paper/Year/Method/Dataset/Findings/Limitations), Download CSV/XLSX/Copy MD.

**Saved searches (`saved_searches` table)**

- `GET/POST/DELETE /api/searches`, `POST /api/searches/{id}/run` — run rebuilds query with stored filters (`year`, `tag`, `collection`, `author` tokens) and calls `api_search(q, limit=20)`; refreshes `updated_at`.
- UI: Search page — save current query (name + query), list of pill buttons (run/delete), empty hint.

**Related documents (`GET /api/library/documents/{id}/related`) — labeled relations, never one blended score**

| Key | Mechanism | Label |
|---|---|---|
| `semantic` | averaged chunk embeddings → `similarity_search_by_vector(k=30)` (absolute `resolve_stored_path` match) | `semantic similarity (embeddings)` |
| `shared_authors` | `document_authors` overlap (`COUNT(*) OVERLAP`) | `shared author(s) (n)` |
| `shared_topics` | `tags`/`collections` overlap | `shared topics: …` |
| `citations` | `source_citations.cited_source_id` / `cited_identifier == case_number` (Phase 8 graph) | `cited here: …` / `cites this case` |

- DocDetail → Related tab groups by label.

### Phase 6 — Evidence/Claim System (P2)

- Tables `claims` + `citations` (support `supports|contradicts|mentions` + locator `p.17`).
- Endpoints: `POST /api/claims` (`{project_id?, text}`), `GET /api/projects/{id}/claims` → `get_claim_with_evidence` (grouped `supports/contradicts/mentions` with title/doi/case_number), `DELETE /api/claims/{id}`, `POST /api/claims/{id}/citations` (`{document_id, support, locator}` → resolves `document_id` → `source_id`).
- UI: Projects detail → Claims — add claim input, list with grouped evidence pills, delete, link evidence (doc select + support + locator), plus existing `evidence_items` (flat claim+quote) and research trail.

### Phase 7 — Serious PDF Research Tools

**Better annotations (`annotations` table now `tags_json`, `project_id`, `claim_id`)**

- `PATCH /api/library/documents/{id}/annotations/{aid}` — patch `note/color/category/page/tags/project_id/claim_id` (tags as `tags_json` JSON); `GET` hydrates `tags`.
- DocDetail AnnotationsPanel — highlight + note creation already present; now supports patching tags/project/claim (extensible).

**Citation-aware reader**

- `GET /api/library/documents/{id}/references?resolve=` — extracts `[23] Text` lines from document text (chunks or `metadata.text_snippet`), optionally fuzzy-matches (`title_fuzzy_score ≥0.55`) against `_library_docs_hydrated()` → `{match: {id, title, score}}`.
- DocDetail → Refs tab (and Reader) lists references with "in library: title (score%)" links.

### Phase 8 — Legal Research Intelligence (P3, differentiation layer)

**Deterministic extraction (`core/legal/extraction.py`)**

- `extract_case_metadata(text)` — court (from `_COURTS` list), case_number (`CASE_NUMBER_RE` / `MK_CASE_NUMBER_RE` → `normalize_case_number`), parties (`Party_RE` + `NAME_RE`, capped 12), `decision_type: putusan`, `decision_date` (Indonesian `12 Maret 2024` → ISO or ISO regex).
- `extract_cited_identifiers(text)` — PUU `90/PUU-XXI/2023` (`CITED_PUU_RE`), cited cases (`CITED_CASE_RE` with court prefix), articles (`PASAL 28D AYAT (1)`, `ARTICLE_RE`), statutes (`undang-undang/uu/perppu/PP/...` + `STATUTE_RE` `11/2008` or `Nomor 11 Tahun 2008`).

**Legally, writes happen in `POST /api/library/documents/{id}/legal/refresh`** — reads chunk text, calls both, `UPDATE sources` (`court`, `case_number`, `decision_date`, `parties_json`), rebuilds `source_citations` rows (resolve `cited_source_id` via `sources.case_number`), updates `documents.citation_metadata`.

**Graph queries:** `GET /api/library/documents/{id}/cited-cases` (`cited` + `citing` via `source_citations.cited_identifier == case_number`), `GET /api/cases/citing?case_number=...` (normalized).

**Legal reasoning (LLM):** `POST /api/research/legal-analysis` (`{document_id}`) → `core/research/analysis.legal_analysis` (SYNTHESIS_MODEL JSON prompt → `facts, issues, legal_basis, arguments, considerations, ratio_decidendi, obiter_dictum, holding`).

### Phase 9 — AI Improvements (only after Phases 1–3 solid)

**Structured extraction** (`POST /api/research/extract` `{document_id, schema: paper|legal}`) — checklist from `analysis.py`: paper → `methodology, research_question, dataset, findings, limitations, contributions, key_citations, future_work`; legal → the 8 putusan sections. `_doc_text` stitches 60k chars, `_chat_json` robustly extracts ```json```.

**Cross-paper synthesis** (`POST /api/research/synthesis` `{document_ids≥2, question}`) — builds `=== Label ===` labeled excerpts (8k chars/doc), `SYNTHESIS_SYSTEM` prompt: Agreement / Disagreement / Research gaps / Claims by support, per-source attribution, never averaging conflicts. Returns `answer` (markdown, rendered in Research → synthesis mode) + `documents` list.

---

## 8. Web UI/UX — Detailed

**Global:** `web/src/app/layout.tsx` (Next.js App Router, `globals.css` shimmer for thinking), `Sidebar`/`Topbar`/`MobileShell`, `ChatContext` (localStorage + `ChatContext:thinking`, history drawer overlay), `Markdown` renderer. Dark theme (`bg-black`, `#0a0a0a` cards, `#2f2f2f` borders, `#ececec` text, emerald pill for Thinking-on).

**Library (`/`, `web/src/app/page.tsx` equivalent)** — table: title (truncate), year, type, collections (pill), tags (#tag), filters `q/year/type/collection/tag` (query params), quick add collection/tag, detail drawer (`DocDetail`) with Metadata/Cite/Related/Refs/Notes tabs, live counts + collections/tags sidebar. Hydrates authors via `document_authors`.

**Search (`/search`):** single box with structured filter hints (`author:"…" year:2024 tag:… collection:…`), grouped results (Documents/Passages/Authors/Collections/Tags, counts), saved-searches strip (name input → Save, pills with run/delete), active structured filters `pre` block.

**Research (`/research`, 5 modes via pill toggle + header controls):**

| Mode | Header | Chat | Footer |
|---|---|---|---|
| **ask** | scope pills (All docs / per-file), Thinking toggle, Memory toggle, Hybrid select, Broad checkbox, Clear chat | standard ask flow (streaming, thinking/answer split, sources collapsible, regenerate/edit) | textarea `Ask the library…` |
| **compare** | per-file multi-select (≥2) | `POST /api/research/compare` (per-source retrieval, labeled `=== Source: … ===`, no averaging) | compare textarea `How do they differ on…` |
| **summarize** | doc select | `POST /api/research/summarize` (stuff/map→reduce→synthesis + verbatim facts) + meta `method • pages • chunks` | static footer + **Export PDF/HTML arm-toggle buttons** (press to arm — button turns white with ✓; the armed format auto-exports from the same summary when it finishes, downloads + verified notification, failures notify without losing the summary; pressing an export button after a summary exists exports immediately; `export_format` in-call avoids re-running the pipeline, unlike manual `POST /api/research/summarize/export`) |
| **matrix** | doc multi-select + Build matrix | table (Paper/Year/Method/Dataset/Findings/Limitations) + Download CSV/XLSX/Copy MD (`POST /api/research/matrix/export`) | static hint |
| **synthesis** | doc multi-select (≥2) | `POST /api/research/synthesis` answer (rendered Markdown: Agreement/Disagreement/Gaps/Claims) | textarea `What does the literature agree or…` + Ask |

Streaming: `api.summarizeStream` SSE (`/api/research/summarize/stream` → `data: {type: status|done|error}`, status carries `stage` + `current/total` for map batches; falls back to plain `api.summarize` if the stream can't start) alongside the existing `api.askStream` SSE (`/api/research/ask/stream` → `data: {type: meta|status|thinking|token|done|error}`), status line (`retrieving` → `reranking` → `preparing` → `processing_prompt` → `generating`), thinking shimmer, abort (↑ → ■, `AbortController`, keeps partial as `(stopped while thinking)`), per-chat memory via `session_id` (the chat's id; `ConversationMemory(MAX_HISTORY_TURNS=3)`, thread-safe). Switching chats switches sessions — nothing is cleared; "Clear memory" clears only the active chat, deleting a chat clears its session too.

**Projects (`/projects`, `/projects/[id]`):** list/create, detail with scoped Ask (uses `document_ids` = project docs + `project_id` for trail), evidence cards (claim + quote), claims graph (text, `supports`/`contradicts`/`mentions` pills, link evidence via doc picker + locator, delete), research trail per project, sources list, notes (markdown textarea + Save).

**Reader (`/reader/[id]`):** PDF iframe (`/api/library/documents/{id}/file` via `resolve_stored_path`) + highlight palette + notes → `annotations`.

**Upload (`/upload` → `UploadFlow.tsx`):** dashed drop zone, Choose file, file name + size, "Analyzing…" + error. Preview: header (`Proposed metadata — human confirms` + `auto_suggest/confirm/create_new` badge + confidence), duplicate warning (hash/DOI/title + confidence), verification card (if OpenAlex hit: `Source: openalex ✓ • Match confidence: N%` + `Other matches:` select + `Reject — use local extraction`), fields (title, authors comma-separated, journal, volume, issue, pages, publisher, abstract, year, type, jurisdiction, DOI) + collections multi-select + suggested collection reason + extraction `text_snippet` + hash/pages/mime. Footer: `Accept & Index — Ready` (→ `POST /api/ingest/confirm` with `citation_metadata`/`metadata_source`/`metadata_confidence`/`metadata_verified`) / Cancel.

**Settings (`/settings`):** sections top-to-bottom:

1. **Chat — Research Ask (26B)** — effective config badge (`model • num_ctx • temperature • num_predict`), inputs: chat model tag, `num_ctx` (4096–131072), safety margin, temperature (0–2), `num_predict`; Save / Reset (`PUT /api/config` via `get_chat_config`).
2. **Citation — CSL styles** — default style select (from `GET /api/citations/styles`), fetch-by-id (CSL repo), add custom XML textarea (`POST /api/citations/styles/*`).
3. **Import / Export** — One-Click Importer file picker (`POST /api/import/file` with collection preservation) + paste textarea + format select + Import; export buttons (BibTeX/RIS/CSL-JSON/bibliography).
4. **Watch-Folder Automation** — dot + `Watching`/`Paused` + `watching • polling/stopped` + Enable/Pause (`POST /api/watch/toggle`, `GET /api/watch/status`).
5. **Model configuration** — `embedding_provider/model`, `auto_organize_threshold_*`, `strict_offline_mode`.
6. **Privacy / Offline** — `strict_offline_mode=true` (blocks non-localhost; skips metadata network).
7. **Storage** — paths (`library.db`, `documents/`, `chroma_db/`), JSON dumps of `health` + `chatCfg`, backup button (`POST /api/backup`).
8. **Shortcuts** — `/` focuses search, queue states, chat history via localStorage.

**Empty/loading/error states:** every view has them; Upload shows duplicate block; Research shows `(stopped — nothing generated yet)` + shimmer; Search shows "No passages — …" when vector store empty.

---

## 9. API Reference

### Health & Config

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{status, documents, collections, tags, chroma_chunks, chroma_status, engine}` |
| GET | `/api/config` | Effective chat config `{rag_provider: "ollama", rag_model, chat: {model, num_ctx, ctx_safety_margin, temperature, num_predict}, thinking_available}` |
| PUT | `/api/config` | `{chat_model?, chat_num_ctx?, chat_ctx_safety_margin?, chat_temperature?, chat_num_predict?}` → 400 on invalid int/float |
| GET | `/api/library/stats` | `{total, by_type, by_year, recent}` |
| GET | `/api/watch/status` | `{enabled, watching, alive}` |
| POST | `/api/watch/toggle` | `{enabled?}` → `{enabled}` |
| POST | `/api/backup` | SQLite online backup → `backups/library_*.db`, keeps 10 newest |

### Library

| Method | Path |
|---|---|
| GET | `/api/library/documents?q=&collection_id=&tag_id=&year=&doc_type=&limit=&offset=` |
| GET | `/api/library/documents/{id}` |
| PATCH | `/api/library/documents/{id}` (`DocumentPatch`: scalar fields + `authors`, `volume`/`issue`/`pages`/`publisher`, `citation_metadata`) |
| DELETE | `/api/library/documents/{id}` |
| POST | `/api/library/documents/{id}/collections` |
| POST | `/api/library/documents/{id}/tags` |
| GET | `/api/library/documents/{id}/file` (FileResponse) |
| GET | `/api/library/documents/{id}/related` (labeled: semantic/shared_authors/shared_topics/citations) |
| GET | `/api/library/documents/{id}/references?resolve=` |
| POST | `/api/library/documents/{id}/legal/refresh` |
| GET | `/api/library/documents/{id}/cited-cases` |
| GET | `/api/cases/citing?case_number=` |

### Ingestion

| Method | Path | Body |
|---|---|---|
| POST | `/api/ingest/preview` | multipart `file` (streamed, 150 MB cap) → `{temp_id, filename, file_hash, extracted, metadata_proposal, metadata_candidates, metadata_error, offline, duplicates, suggested_collection, decision, text_snippet}`. Previews live 30 min, max 20 pending — confirm in time or re-upload |
| POST | `/api/ingest/confirm` | `IngestConfirm{temp_id, title, authors, year, doi, journal, abstract, volume, issue, pages, publisher, citation_metadata, metadata_source, metadata_confidence, metadata_verified, collection_ids, tag_ids, action}`. Hash-duplicate races against concurrent confirms end in 409 via `UNIQUE(file_hash)` |
| POST | `/api/library/documents/upload` | legacy direct upload (wraps preview+confirm) |

### Citations & Styles

| Method | Path |
|---|---|
| GET | `/api/citations/styles` (`{styles, default}`) |
| PUT | `/api/citations/styles/default` |
| POST | `/api/citations/styles/custom` (`{xml}`) |
| POST | `/api/citations/styles/fetch` (`{name}`) |
| GET | `/api/citations/{id}?style=apa` (`{plain, style, citation, bibtex, ris, csl_json}`) |
| GET | `/api/export/bibtex?ids=` (legacy) |
| GET | `/api/export/refs?format=bibtex|ris|csl-json&ids=` |
| GET | `/api/export/bibliography?style=apa&ids=` |

### Import / Capture

| Method | Path |
|---|---|
| POST | `/api/import/refs` (`{text, format?}`) |
| POST | `/api/import/file` (multipart `file`) — One-Click Importer, collection-preserving |
| POST | `/api/capture` (`{url?, doi?, title?}`) — browser extension |

### Search

| Method | Path |
|---|---|
| GET | `/api/search?q=&limit=` (grouped + `filters` + `counts`) |

### Research

| Method | Path |
|---|---|
| POST | `/api/research/ask` (`AskRequest{query, document_ids?, collection_id?, project_id?, broad, thinking, use_memory, clear_memory, hybrid_mode, session_id="default"}`) |
| POST | `/api/research/ask/stream` (SSE, same body incl. `session_id`) |
| GET | `/api/research/memory?session_id=` (`{enabled, turns}` for that chat) |
| POST | `/api/research/memory/clear?session_id=` (clears only that chat's session) |
| POST | `/api/research/summarize` (`SummarizeRequest{document_id, mode?, export_format?: pdf|html}` → `{summary, stats, document, export?{format, filename, size_bytes}, export_content?(base64), export_error?}`; the inline export renders the same summary, verified by `_verify_export_file` ≥500 bytes) |
| POST | `/api/research/summarize/stream` (SSE: `status` per pipeline stage — `classifying → mapping (batch current/total) → reducing → synthesizing → exporting` — then `done` with the same payload, or `error`; the worker thread streams progress while the sync pipeline runs) |
| POST | `/api/research/summarize/export` (`{document_id, format: pdf|html}` → FileResponse) |
| POST | `/api/research/compare` (`CompareRequest{query, document_ids[]}`) |
| POST | `/api/research/matrix` (`{document_ids[]}` → `{rows}`) |
| POST | `/api/research/matrix/export` (`{rows, format: csv|md|xlsx}` → Response blob/json) |
| POST | `/api/research/extract` (`{document_id, schema: paper|legal}`) |
| POST | `/api/research/synthesis` (`{document_ids[], question}`) |
| POST | `/api/research/legal-analysis` (`{document_id}`) |

### Projects / Claims

| Method | Path |
|---|---|
| GET | `/api/research/projects` |
| POST | `/api/research/projects` |
| GET | `/api/research/projects/{id}` (docs + evidence + queries) |
| POST | `/api/research/projects/{id}/documents` |
| DELETE | `/api/research/projects/{id}` |
| GET | `/api/projects/{id}/claims` |
| POST | `/api/claims` (`{project_id?, text}`) |
| DELETE | `/api/claims/{id}` |
| POST | `/api/claims/{id}/citations` (`{document_id, support, locator?}`) |
| POST | `/api/research/projects/{id}/evidence` (`{claim, quoted_evidence, page?}`) |
| GET | `/api/research/trail?limit=` |

### Searches / Viewer

| Method | Path |
|---|---|
| GET | `/api/searches` |
| POST | `/api/searches` (`{name, query, filters?}`) |
| DELETE | `/api/searches/{id}` |
| POST | `/api/searches/{id}/run` |
| GET | `/api/library/documents/{id}/annotations` |
| POST | `/api/library/documents/{id}/annotations` |
| PATCH | `/api/library/documents/{id}/annotations/{aid}` (`{note, color, category, page, tags, project_id, claim_id}`) |
| DELETE | `/api/library/annotations/{id}` |
| GET | `/api/citations/{id}` |
| GET | `/api/export/bibtex` |

---

## 10. Configuration

**`config.py` (Ollama-only)**

| Key | Default | Notes |
|---|---|---|
| `RAG_MODEL` / `SYNTHESIS_MODEL` | `gemma4:26b-a4b-it-qat` | 26B; chat uses `get_chat_config()` overrides |
| `MAP_MODEL` / `DOC_TYPE_MODEL` | `qwen3.5:4b` | Fast, mechanical |
| `REDUCE_MODEL` | `qwen2.5:7b` | Consolidation |
| `EMBED_MODEL` | `nomic-embed-text` | Changing ⇒ `reindex` |
| `NUM_CTX` | `32768` | Per-request KV cache for 26B (128k physical, VRAM-bound) |
| `CTX_SAFETY_MARGIN` | `800` | Headroom |
| `GENERATION_TEMPERATURE` | `0.0` | Deterministic |
| `RAG_NUM_PREDICT` | `2048` | Chat cap; `None` = model default |
| `MAP_NUM_CTX`/`REDUCE_NUM_CTX` etc. | `6144`/`12288` | Stage-specific caps |

Settings that survive restarts live in `settings` KV (`PUT /api/settings` or `PUT /api/config`): `chat_model`, `chat_num_ctx`, `chat_ctx_safety_margin`, `chat_temperature`, `chat_num_predict`, `strict_offline_mode`, `auto_organize_threshold_*`, `embedding_*`, `citation_style`, `custom_csl_xml`.

---

## 11. One-Click Importer & Watch-Folder

**One-Click Importer** (`POST /api/import/file`, `POST /api/import/refs` + `core/importing/parsers.py`)

- Parsers: BibTeX (nested-brace-aware, `author = {A and B}`, `journal`/`journaltitle`/`booktitle`, `number`→`issue`, `pages --`→`-`, `doi` lowercased), RIS (`TY`/`AU`/`TI`/`PY`/`JO`/`VL`/`IS`/`SP`+`EP`→`pages`), CSL-JSON (`author[].family/given`, `issued.date-parts`), EndNote XML (`<record><title><authors>`). Collections from `groups`/`collection`/`keywords` (BibTeX), `KW`/`DB` (RIS), `group`/`collection` (EndNote), `collection-title` (CSL-JSON) — deduped, ≤5 per record.
- `POST /api/import/file` accepts the raw export file; auto-detects via extension (`*.bib`→bibtex etc.) or content sniff; delegates to text importer.
- Dedupe by `lower(doi)` then `lower(title)`; creates `collections` on demand and links `document_collections`; `file` fields (linked PDFs) copied into content-addressed store when found on disk.

**Watch-Folder** (`server.py: _watch_pfolder_loop`)

- Daemon thread managed by the `lifespan` context: `DOC_FOLDER` polled every 30s, `get_indexed_documents` → `sync_new_files` (chunk + embed + `add_documents` with continued `chunk_index`, `tag_chunks_with_pinpoints`) serialized with ingest-confirm writes under one lock (Chroma/SQLite takes a single writer); falls back gracefully when `chroma_db` empty or Ollama offline. Expired upload previews are swept on the same tick. Toggle via `POST /api/watch/toggle`.
- Locking discipline: one shared Chroma client (chromadb has no `close()`); reads take **no** lock (lock-free cached fast path — an earlier version locked every `_get_vectorstore()` call and stalled all reads behind minutes-long ingests), creation single-flights under `_chroma_lock`, writers hold it across mutations. SQLite rows are written from many endpoints outside that lock, so every connection sets `PRAGMA busy_timeout = 5000` (WAL mode) instead of failing instantly on contention.

---

## 12. PDF/HTML Export — Summarization

CLI already supported `summarize: X html`/`pdf` via `summary_export.py` (markdown→HTML via `markdown`+tables+MathJax CDN; PDF via `xhtml2pdf` + Unicode TTF Arial/DejaVu, ASCII fold fallback).

**New web path:** `POST /api/research/summarize/export` (`{document_id, format: "pdf"|"html"}`) re-runs `summarize_document` for the document (resolving `stored_path` → Chroma `full_source` with filename fallback), calls `export_summary_html/pdf`, and returns `FileResponse` (`text/html` or `application/pdf`, `filename: <doc>_summary.{html,pdf}`). Research → summarize mode now shows **Export PDF** / **Export HTML** next to `Summarize` (disabled until a doc is selected; `api.summarizeExport` → `URL.createObjectURL(blob)` download).

---

## 13. Browser Extension

`browser-extension/` (MV3, minimal — one action):

| File | Purpose |
|---|---|
| `manifest.json` | `manifest_version:3`, `activeTab` + `storage`, `host_permissions: http://127.0.0.1:8000/*`, `action.default_popup: popup.html`, `background.service_worker: background.js` |
| `background.js` | `chrome.runtime.onMessage` handler for `type:"capture"` → `fetch(${apiUrl}/api/capture, {url, doi, title})` (URL-trimmed `DEFAULT_API`) |
| `popup.html` | title, DOI/title inputs (DOI pre-filled from tab URL via `DOI_RE`), Save button, status line |
| `popup.js` | `chrome.tabs.query` for active tab, `chrome.runtime.sendMessage` to background, shows `ok/data.document.id` + `downloaded_pdf`/`metadata_source` |
| `README.md` | Install (Developer mode → Load unpacked) + use notes |

---

## 14. File Structure

```
mlra/
├── config.py                      # Ollama routing + get_chat_config()
├── llm_client.py                  # Ollama chat/stream + embeddings
├── ingestion.py                   # loaders, chunking, sync_new_files
├── retrieval.py                   # HybridIndex, rerank, sort_docs
├── generation.py                  # prompts, get_chat_config, thinking
├── summarization.py               # stuff/map→reduce→synthesis + verbatim facts/tables
├── summary_export.py              # HTML/PDF export (markdown+xhtml2pdf+MathJax)
├── conversation.py                # bounded toggleable Q&A memory (thread-safe; server scopes one per chat session)
├── research_trail.py              # append-only trail + citation export
├── document_loaders.py / heading_detection.py / metadata_extraction.py / jurisdiction_extraction.py / pinpoint_detection.py / text_quality.py
├── main.py                        # CLI REPL
├── server.py                      # FastAPI: 40+ endpoints, shared Chroma client, per-session memory, lifespan (watch-folder + preview sweeps)
├── storage/
│   ├── sqlite.py                  # schema, migrations, DEFAULT_SETTINGS, dict_from_row
│   └── filesystem.py              # content-addressed save/resolve
├── core/
│   ├── library/{documents,collections,tags,sources}.py
│   ├── ingestion/{deduplication,classifier}.py
│   ├── metadata/{providers.py}    # OpenAlex + local + fetch_metadata
│   ├── citations/{engine.py,styles/*.csl}
│   ├── importing/parsers.py       # BibTeX/RIS/EndNote/CSL-JSON
│   ├── legal/extraction.py        # case metadata + cited identifiers
│   └── research/analysis.py       # matrix, extract, synthesis, legal_analysis
├── tests/
│   ├── test_metadata_providers.py # DOI hit/miss, trailing-punct, abstract rebuild
│   ├── test_ingest_metadata.py    # migration, round-trip, never-overwrite, sources
│   ├── test_phase2_3.py           # CSL, parsers, legal extraction
│   └── smoke_endpoints.py         # 22 HTTP checks (citations, import, bibliography, searches, claims, related, refs, legal, matrix)
├── browser-extension/{manifest.json,background.js,popup.html,popup.js}
├── web/
│   ├── src/app/{layout,page,search,upload,research,projects/[id],reader/[id],settings}
│   ├── src/components/{DocDetail,UploadFlow,ChatHistoryPanel,Markdown,Sidebar,Topbar}
│   ├── src/lib/api.ts             # apiFetch + typed api surface
│   └── src/contexts/ChatContext.tsx
├── pfolder/ / chroma_db/ / rerank_cache/ / summaries/ / research_workbench/ / storage/
├── requirements.txt (httpx, citeproc-py, citeproc-py-styles, langchain*, chromadb, pymupdf, xhtml2pdf, openpyxl, ...)
├── run.ps1 (+ start_backend.ps1), import_legacy.py
├── README.md (user guide) + details.md (this file, technical reference) + web/README.md (frontend notes)
└── arlms/ (legacy snapshot, not imported — safe to delete)
```

---

## 15. Workflow Examples

**Zotero → Workbench → LaTeX**

1. Zotero: File → Export Library → RIS or BibTeX → `library.ris`
2. Workbench Settings → Import/Export → One-Click Importer file picker → `library.ris` (or paste) → `POST /api/import/file` → collections preserved, duplicates skipped.
3. Research → matrix on `library.ris` docs → CSV/XLSX/MD → LaTeX table.
4. Export BibTeX (`GET /api/export/refs?format=bibtex`) → `library.bib` → `\bibliography{library}`.

**Watch-folder**

1. Enable in Settings → Watch-Folder Automation (or leave default enabled).
2. Drop a PDF into `pfolder/subdir/` while the backend is running.
3. Within 30s the doc appears in Library and is searchable/askable — no restart, no `reindex`.

**PDF report**

1. Research → summarize → select `paper.pdf` → Summarize.
2. Click **Export PDF** (or HTML) → download `paper_summary.pdf` (styled, paginated A4, MathJax only in HTML).

**Legal**

1. Upload a putusan PDF → metadata extraction fills jurisdiction/type.
2. `POST /api/library/documents/{id}/legal/refresh` → `sources` gets `court/case_number/parties`, `source_citations` edges built.
3. `GET /api/cases/citing?case_number=90/PUU-XXI/2023` → "show decisions citing this case"; DocDetail → Related → Citation relationships.

---

## 16. Troubleshooting

| Issue | Fix |
|---|---|
| `Ollama connection refused` | `ollama serve` + `ollama list`; check `http://localhost:11434/api/tags` |
| OOM on 26B | Settings → Chat: lower `chat_num_ctx` to 8192; or `config.py` lower `MAP_NUM_CTX`/`REDUCE_NUM_CTX` / use smaller synthesis model |
| `flashrank` download fails | check internet/proxy; set `RERANK_CACHE_DIR` to a pre-downloaded model |
| `Error finding id` (Chroma) | reduce `SIMILARITY_K`/`BROAD_K`; system caps `k` when filter active |
| Upload ends `ingestion_status='error'` | Ollama runner unreachable mid-burst — see §6 lifecycle note; `ollama ps`, delete row, re-upload |
| `Preview expired or not found` | previews live 30 min / 20 pending max; re-upload |
| `LOI` locale error in CSL | bundled `locales-en-US.xml` present; if custom CSL uses another locale, add its XML to `citeproc/data/locales/` |
| Extension not saving | check backend is running (`/api/health`), `chrome://extensions` Developer mode → Load unpacked, `activeTab` permission |

---

## 17. Tests & Verification

- **Unit:** `python -m unittest discover -s tests` — 37 tests (metadata providers DOI hit/miss/trailing-punct/abstract, FetchMetadata offline/degraded/ambiguous, storage migration/round-trip/never-overwrite/sources, CSL render/bibliography/custom, parsers BibTeX-nested-braces/RIS/CSL-JSON/EndNote, legal case metadata/normalize/cited identifiers).
- **Smoke:** `python tests/smoke_endpoints.py` — 22 HTTP checks: citation styles (7), import (BibTeX + dedupe), CSL styles (apa/oscola), custom invalid, export RIS/CSL-JSON/bibliography, saved searches, claims evidence grouping, related (labeled), references, legal refresh, matrix csv/md/xlsx, default style. Runs against the **real local DB** (imports a test row, deletes it + its claim on exit even on failure) — not hermetic by design, since the point is the wired stack.
- **Frontend:** `web: npx tsc --noEmit` (TS), `npx eslint` (only pre-existing `no-explicit-any`/`purity` style warnings).

---

## 18. Roadmap Status

| Phase | Feature | Status |
|---|---|---|
| P0 | OpenAlex metadata + verification UI | ✅ |
| P0 | CSL citation engine + style manager | ✅ backend citeproc-py |
| P0 | BibTeX/BibLaTeX/RIS/EndNote XML/CSL-JSON import/export | ✅ |
| P1 | One-Click Importer (file upload, collection-preserving) | ✅ this release |
| P1 | Watch-Folder Automation (pfolder polling) | ✅ this release |
| P1 | Browser capture extension | ✅ MV3 |
| P1 | Literature matrix | ✅ + CSV/XLSX/MD |
| P1 | Saved searches | ✅ |
| P1 | Related documents (labeled) | ✅ |
| P1 | Better annotations (tags+project/claim) | ✅ |
| P2 | Claim → evidence graph | ✅ supports/contradicts/mentions |
| P2 | Citation graph | ✅ legal case/statute/Pasal |
| P2 | Structured extraction + cross-paper synthesis | ✅ |
| P3 | Legal intelligence (case metadata, reasoning, citation graph) | ✅ |
| P3 | Summarization PDF export (web button) | ✅ this release |
| — | Collaboration / cloud sync | deferred |

---

## 19. Scripts

- `import_legacy.py` — one-time `pfolder/` → SQLite (already run).
- `run.ps1` — starts backend + frontend, waits for `/api/health`, prints URLs, stops on Enter.
- `start_backend.ps1` — backend only.
- `web/README.md` — frontend dev notes.
- `browser-extension/` — load unpacked in Chrome/Edge (see its README).
- `arlms/` — legacy snapshot, not imported — safe to delete.

---
