# Research Workbench — Technical Details (Cloud Version)

> Stack: Vercel + Next.js 16 + Supabase (Postgres/Auth/Storage/Realtime/pgvector/FTS) + browser-side Ollama/BYOK.
> Principle: Supabase owns shared state; browser owns AI; each member owns inference.
> UI: 1:1 port of the original local app (same pages, components, styling, interactions).

## 1. Constraints (enforced)

- No FastAPI/SQLite/Chroma/filesystem source of truth. No `pfolder/`, `library.db`, `chroma_db/`.
- Vercel never calls user localhost — `OllamaProvider` runs in-browser only.
- BYOK keys: AES-GCM at rest (`lib/ai/keys.ts`, `ai_credentials` owner-only RLS), never `NEXT_PUBLIC_*`.
- Inference settings: `InferenceContext` (localStorage). Server records only `{provider, model}` in `message.metadata_json`.
- `MAX_ALLOWED_MEMBERS = 10` clamped server-side (members POST, limit PATCH, DB CHECK).
- Kick: `status='removed'` + `auth.admin.signOut(userId)`; no account hard-delete.
- Chat RLS: SELECT workspace-visible; INSERT/UPDATE/DELETE owner-only (`chat.owner_id = auth.uid()`).

## 2. How the UI port works

## 2b. Chat semantics (publish gallery model)

- The **Shared chats** gallery is read-only: nobody starts or continues a
  conversation there. It only receives published research.
- **Publish**: Research history drawer → Publish ↑ exports the thread (content +
  sources + thinking + model, stored in `chat_messages.metadata_json`).
- **Import**: gallery → Open in Research, or Research drawer → Shared → Import ↓ —
  creates a new local conversation seeded with the shared messages; your own
  model continues it. (`POST /api/chats/import` was removed with the old model.)
- **Delete**: owner files a `chat_deletion_requests` row (one pending per chat,
  RLS-enforced); admin approves (chat + messages deleted, request kept as audit)
  or rejects. No unilateral deletes.
- Migration `0004_deletion_requests.sql` adds the table + RLS (run it in SQL Editor).

`src/lib/api.ts` is a browser facade exposing the **original method names** (`api.listDocuments`, `api.ask`, `api.compare`, …) re-implemented against Supabase + browser inference. Pages and components keep their exact JSX; only id types changed (`number` → `string` uuid) plus the adaptations in §4. Data modules live in `src/lib/wb/` (library, search, ask, projects, related, ingest, openalex).

## 3. Schema

Migration `0001_init.sql`: profiles, workspaces, workspace_members, documents (+`fts` tsvector, `status` pending/approved/rejected), sources, source_citations, authors, document_authors, collections, document_collections, tags, document_tags, research_projects, research_project_documents, research_queries, claims, citations, evidence_items, annotations, research_trail, saved_searches, document_chunks (+`fts`), document_embeddings (`vector(768)`, HNSW cosine), chats, chat_messages (`metadata_json`), chat_imports, ai_credentials. Domain columns ported 1:1 from the old `storage/sqlite.py`.
RPCs: `fts_search_chunks` (websearch_to_tsquery + ts_rank_cd, approved-only), `vector_search_chunks` (cosine `<=>`, approved-only).
`0002_storage.sql`: private `documents` bucket, `<workspace_id>/` prefix policies.
Realtime publication (run once):
```sql
alter publication supabase_realtime add table
  public.workspace_members, public.documents, public.chats,
  public.chat_imports, public.research_projects, public.research_trail;
```

## 4. Honest behavior deltas vs the original local app

UI is identical; where the old backend did something the new architecture cannot, the port does the faithful equivalent:

- **Ask streaming**: Ollama streams tokens via `/api/chat` NDJSON (same SSE-style UI: status line, thinking box, stop-keeps-partial). Cloud answers are chunk-simulated into the same streaming UI.
- **Thinking**: `think=true` for Ollama + `<think>` parsing fallback; cloud models show no thinking box.
- **Memory**: per-conversation prior messages sent as context (Memory toggle); "Clear memory" sets a cutoff — visible chat unchanged. (Old: server-side per-session memory.)
- **Hybrid low→maximum**: prompt-level grounding instructions (old: server-side context mixing). Disclaimer UI unchanged.
- **Summarize**: single-pass synthesis over stitched text (≈60k chars) + stats line; no map→reduce stages. Export PDF opens a print view (Save as PDF); Export HTML downloads a styled file. Arm-toggle flow preserved.
- **Matrix**: per-doc STRICT-JSON extraction via your model; CSV/MD/XLSX (SheetJS) client-side.
- **Upload**: PDF parsing via pdfjs-dist in-browser (non-PDF via text read); DOCX/XLSX/PPTX/RTF loaders not ported — PDF/TXT/MD/CSV/HTML covered. OpenAlex via browser fetch (CORS-open). Confirm → Storage + rows + embeddings → `pending` (new: admin approval in Admin dashboard, approval queue included).
- **Citations**: citeproc-js in-browser with the same 7 vendored styles + en-US locale; fetch-by-id from the CSL repo; custom XML; default style — all per-device localStorage (old: server-wide setting).
- **Related**: same 4 labeled groups (citation graph, shared authors, shared topics, semantic via averaged chunk embeddings + RPC).
- **Refs**: `[...]` extraction + fuzzy ≥0.55 match, same UI.
- **Legal**: deterministic refresh (court/case/parties/date + citation edges + resolve) ported 1:1; legal-analysis/extract run through your model with the original prompts.
- **Settings**: Chat card → this-device inference (provider/model/ctx/temp/embed mode/cloud key/autodetect); Import/Export fully client-side (imports become pending records); Watch-folder card replaced by Workspace card (no daemon, by design); Storage card → Supabase info + workspace JSON export (replaces SQLite backup file); Privacy card rewritten for the new model.
- **Auth shell**: `/login`, `/register` (member + admin bootstrap), route guard + sidebar sign-out + admin-only Admin nav. `/dashboard` and `/library` redirect to `/` (library is home, as in the original).

## 5. Ports (Python → TypeScript)

| Old | New |
|---|---|
| `core/ingestion/deduplication.py` | `lib/ingestion/dedup.ts` |
| `core/ingestion/classifier.py` | `lib/ingestion/classify.ts` |
| chunking (`ingestion.py` 4700/880) | `lib/ingestion/chunking.ts` |
| `core/citations/engine.py` | `lib/citations/csl.ts` (citeproc-js) + `lib/citations/index.ts` |
| `core/importing/parsers.py` | `lib/importing/parsers.ts` |
| `core/legal/extraction.py` | `lib/legal/extraction.ts` |
| `core/metadata/providers.py` | `lib/wb/openalex.ts` (browser fetch) |
| `core/research/analysis.py` | `lib/wb/ask.ts` (same prompts/shapes) |
| FastAPI routes | `lib/api.ts` facade + Next.js API routes (`api/auth`, `api/workspaces`, `api/documents/approve`, `api/chats/import`, `api/ai/proxy`, `api/rag/*`, `api/research/trail`) |
| SQLite/Chroma/BM25/rerank | Postgres FTS + pgvector + RRF (no reranker; Phase-7 hook in `/api/rag/search`) |

## 6. Roadmap status

- Phase 1 (foundation/auth/admin/kick): done. Phase 2 (library + Storage + approval): done.
- Phase 3 (research entities + RLS): done. Phase 4 (chat + RLS + import): done.
- Phase 5 (FTS + pgvector + RRF): done (MVP; rerank deferred).
- Phase 6 (AIProvider + Ollama/Cloud + embed toggle): done.
- Phase 7 (polish): realtime + approval UI + admin dashboard + auto-detect + cloud settings done; original UI ported 1:1 (this document §4 lists the equivalents).
- Follow-ups: RAG reranker, DOCX/XLSX/PPTX browser loaders, multi-workspace switching, server-wide citation default.
