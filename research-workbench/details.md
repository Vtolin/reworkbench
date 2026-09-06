# Research Workbench — Technical Details (Cloud Migration)

> Stack: Vercel + Next.js 16 + Supabase (Postgres/Auth/Storage/Realtime/pgvector/FTS) + browser-side Ollama/BYOK.
> Principle: Supabase owns shared state; browser owns AI; each member owns inference.

## 1. Constraints (enforced)

- No FastAPI/SQLite/Chroma/filesystem source of truth. No `pfolder/`, `library.db`, `chroma_db/`.
- Vercel never calls user localhost — `OllamaProvider` runs in-browser only.
- BYOK keys: AES-GCM at rest (`lib/ai/keys.ts`, `ai_credentials` owner-only RLS), never `NEXT_PUBLIC_*`.
- Inference settings: `InferenceContext` (localStorage). Server records only `{provider, model}` in `message.metadata_json`.
- `MAX_ALLOWED_MEMBERS = 10` clamped server-side (`members` POST, `limit` PATCH, DB CHECK).
- Kick: `status='removed'` + `auth.admin.signOut(userId)`; no account hard-delete.
- Chat RLS: SELECT workspace-visible; INSERT/UPDATE/DELETE owner-only (`chat.owner_id = auth.uid()`).

## 2. Schema

Migration `0001_init.sql`: profiles, workspaces, workspace_members, documents (+`fts` tsvector, `status` pending/approved/rejected),
sources, source_citations, authors, document_authors, collections, document_collections, tags, document_tags,
research_projects, research_project_documents, research_queries, claims, citations, evidence_items, annotations,
research_trail, saved_searches, document_chunks (+`fts`), document_embeddings (`vector(768)`, HNSW cosine),
chats, chat_messages (`metadata_json`), chat_imports, ai_credentials.
Domain columns ported 1:1 from `storage/sqlite.py` (volume/issue/pages/publisher, citation_metadata, legal case fields, tags_json/project/claim links).
RPCs: `fts_search_chunks` (websearch_to_tsquery + ts_rank_cd, approved-only), `vector_search_chunks` (cosine `<=>`, approved-only).
`0002_storage.sql`: private `documents` bucket, `<workspace_id>/` prefix policies.
Realtime: `supabase/config.toml` lists workspace_members, documents, chats, chat_imports, research_projects, research_trail.

## 3. RAG

`Query → FTS + pgvector → RRF(k=60) → top passages → browser prompt → local/cloud model` (`lib/rag/`).
MVP has no reranker (Phase 7 hook: add cross-encoder in `/api/rag/search` before fusion).
Embedding modes: local via `OllamaProvider.embed(nomic-embed-text)` in-browser; server via `/api/rag/embed` (member key) or Edge Function `supabase/functions/embed`.

## 4. Ingestion

Deterministic (browser/Vercel): `chunking.ts` (4700/880, paragraph-aware, `sha256Hex`, `pseudoPaginate(3000)`, `extractPdfTextBrowser` via pdfjs-dist), `dedup.ts` (SHA→DOI→title→author/year→fuzzy≥0.85), `classify.ts` (legal/empirical/survey/thesis/general + collection suggestion).
AI-required: embeddings/summarization/generation via selected provider.
Flow: Storage upload → extract/chunk/metadata → embed (local or cloud) → documents/chunks/embeddings rows.

## 5. Auth & admin

- `POST /api/auth/register-admin` (service role): key check → user → workspace → admin membership.
- `POST /api/workspaces/members`: server-side limit re-check → 403 "Registration is currently closed…" when full.
- `PATCH /api/workspaces/limit`: `clampMemberLimit` (1..10).
- `POST /api/workspaces/kick`: admin check → soft-remove → signOut.
- `middleware.ts` refreshes sessions; RLS policies mirror all app checks.

## 6. Ports (Python → TS)

| Old | New |
|---|---|
| `core/ingestion/deduplication.py` | `lib/ingestion/dedup.ts` |
| `core/ingestion/classifier.py` | `lib/ingestion/classify.ts` |
| chunking (`ingestion.py` 4700/880) | `lib/ingestion/chunking.ts` |
| citation engine | `lib/citations/` (docToCslItem, plain renderer, Pasal/PUU extraction) |
| research analysis | `lib/research/analysis.ts` (matrix/synthesis/compare prompts, JSON parse) |
| FastAPI routes | Next.js API routes (`api/auth`, `api/workspaces`, `api/documents/approve`, `api/chats/import`, `api/ai/proxy`, `api/rag/*`, `api/research/trail`) |
| SQLite/Chroma/BM25 | Postgres FTS + pgvector + RRF |

## 7. Roadmap status

- Phase 1 (foundation/auth/admin/kick): done.
- Phase 2 (library + Storage + approval): done.
- Phase 3 (research entities + RLS): done (schema + projects/claims UI + trail API).
- Phase 4 (chat + RLS + import): done.
- Phase 5 (FTS + pgvector + RRF): done (MVP; rerank deferred).
- Phase 6 (AIProvider + Ollama/Cloud + embed toggle): done.
- Phase 7 (polish): realtime + approval UI + admin dashboard + auto-detect + cloud settings done; rerank + import/export formats remain as follow-ups.
