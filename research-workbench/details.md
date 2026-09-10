# Research Workbench — Technical Details (Cloud Version)

> Stack: Vercel + Next.js 16 + Supabase (Postgres/Auth/Storage/Realtime/pgvector/FTS) + browser-side Ollama/BYOK.
> Principle: Supabase owns shared state; browser owns AI; each member owns inference.
> UI: 1:1 port of the original local app (same pages, components, styling, interactions), plus Makalah drafting (no predecessor).
>
> Audience: contributors. End users should start at `README.md` (setup, joining, key flows).

## 1. Architecture

### 1.1 Ownership split

Three parties, each owning what it is good at:

| Owner | Owns | Never touches |
|---|---|---|
| **Supabase** | Shared library, chats, projects, approvals, keys-at-rest, vectors, FTS | Any inference |
| **Browser** | All inference (Ollama `localhost:11434` or BYOK cloud via proxy), retrieval orchestration, parsing, rendering | Other members' keys/models |
| **Vercel** | Static UI, auth screens, API routes (authz + data + cloud-key proxy) | `localhost` — it physically cannot reach a member's Ollama |

Consequences that shape every design decision below: there is no app server that can see documents *and* run models, so RAG orchestration lives in `src/lib/` and runs in the tab. The server only ever records `{provider, model}` labels for reproducibility (`message.metadata_json`), never prompts or keys in cleartext.

### 1.2 Request flows

**Ask (Ollama path — the hot path):**

```text
Research page
  → api.ask / api.askStream          (src/lib/api.ts facade)
    → retrieveContext                (src/lib/rag/retrieve.ts, browser)
      → embed query (Ollama nomic-embed-text, browser → localhost)
      → POST /api/rag/search         (server: FTS + pgvector RPCs, RLS-gated)
      → BM25 leg + RRF fusion + cross-encoder rerank (browser, deterministic)
    → OllamaProvider.chat            (browser → localhost:11434, SSE streaming)
    → render tokens + sources        (thinking box, stop-keeps-partial)
```

**Ask (cloud path):** identical until generation, which goes browser → `POST /api/ai/proxy` (Vercel decrypts the member's own key server-side, forwards to OpenAI/DeepSeek/Google/Anthropic) → chunk-simulated streaming into the same UI.

**Upload:** browser parses (pdf.js / DOCX / SheetJS / slide-XML / RTF-strip) → chunks → embeds (local or server mode) → Storage + rows as `pending` → admin approves → searchable. The server never parses files.

**Publish / import (chats):** Research drawer → `publishConversation` writes to `chats` + `chat_messages` (workspace-visible) → gallery at `/chats` is read-only → Import seeds a *new local* conversation; the member's own model continues it.

### 1.3 Frontend

Routes (`src/app/`): `/` (library), `/search`, `/research`, `/makalah`, `/projects`, `/projects/[id]`, `/chats`, `/reader/[id]`, `/upload`, `/settings`, `/admin`, `/login`, `/register`. (`/dashboard` and `/library` redirect to `/`.) API routes (`src/app/api/`): `ai/proxy`, `ai/proxy/models`, `auth/register-admin`, `documents/approve`, `rag/embed`, `rag/search`, `research/trail`, `workspaces/kick`, `workspaces/limit`, `workspaces/members`. (`POST /api/chats/import` was removed with the old model.)

Shell: `layout.tsx` → `SessionProvider` → `InferenceProvider` → `ChatProvider` → `MakalahProvider` → `AppShell` → `MobileShell` + `Sidebar` + page. `src/proxy.ts` refreshes the Supabase session on every non-static request.

Components (`src/components/`): `AppShell` (auth gate, join gate, layout), `Sidebar` (nav + mobile top bar), `MobileShell` (drawer state, collapse persistence), `Topbar` (per-page header, mobile offset built in), `ChatHistoryPanel` (my/shared chats, publish/import), `MakalahHistoryPanel` (draft list), `Markdown` (KaTeX math), `DocDetail`, `UploadFlow`, `RealtimeToasts`.

Contexts (`src/contexts/`): `SessionContext` (user, workspace, role), `InferenceContext` (per-device model settings, §1.5), `ChatContext` (per-device conversations, §2), `MakalahContext` (per-device drafts, §3).

Mobile contract (all pages): fixed 56px top bar on `<lg`, content offset with `mt-[56px] lg:mt-0`, drawers overlay (`z-20` history, `z-40` nav) instead of pushing content, single scroll container per view, `env(safe-area-inset-bottom)` footers, horizontal-scroll tab strips with `min-w-0` so icon buttons are never pushed off-screen.

### 1.4 Browser API facade

`src/lib/api.ts` exposes the **original method names** (`api.listDocuments`, `api.ask`, `api.compare`, …) re-implemented against Supabase + browser inference, so pages keep their JSX and only id types changed (`number` → `string` uuid). Domain engines live in `src/lib/wb/` (`library`, `search`, `ask`, `projects`, `related`, `ingest`, `openalex`, `publish`, `makalah`); pure prompt/schema/ML helpers in `src/lib/research/` (`summarization`, `analysis`), `src/lib/rag/`, `src/lib/citations/`, `src/lib/legal/`, `src/lib/ingestion/`, `src/lib/importing/`.

`readInference()` merges `rw.inference_settings.v1` over defaults; `toSel()` maps it to an `InferenceSelection` (provider, model, ctx, temp, embed mode, thinking/memory/hybrid flags, summarize method, per-stage overrides). Every research call flows through `toSel()`, so a Settings change applies to the *next* call with no restart.

### 1.5 Inference layer

`AIProvider` (`src/lib/ai/types.ts`): `chat(messages, {model, temperature, numCtx, numPredict, thinking, signal, onToken, onThinking})`, `embed(text)`. Two backends:

- `OllamaProvider` (`src/lib/ai/ollama.ts`) — browser → `localhost:11434` directly. Non-streaming and streaming-NDJSON paths. **Always sends an explicit `think: true/false`** (reasoning models such as qwen3 think natively when the field is omitted and can burn the whole `num_predict` budget on thinking, returning empty content — verified live on `qwen3.5:4b`: omitted → 1024 thinking tokens + 0 answer bytes; `think:false` → clean answer in ~1.6s). When thinking is on, an effort level (`low/medium/high/max`) may be sent instead of `true` as a server-side trace bound. Numeric thinking budgets are NOT a stable Ollama feature (HTTP 400 on 0.33.3) — token budgets are enforced via prompt instruction + `num_predict` accounting (see Makalah). On HTTP 400 the field is retried omitted once (old-server fallback; the `think:true` case additionally reports "not supported" into the thinking box instead of failing). Spontaneous `<think>` tags with the toggle off are stripped silently, never surfaced.
- `CloudProvider` (`src/lib/ai/cloud.ts`) — browser → Vercel proxy → provider with the member's own key. No thinking box (cloud path never sets it).

`InferenceContext` (device-local, `rw.inference_settings.v1`): provider `ollama|cloud`, Ollama tag (default `gemma4:26b-a4b-it-qat`), `numCtx` (default 32768), `temperature` (default 0.0), `embedMode` `local|server`, cloud provider/model (default `openai`/`gpt-4o-mini`), `summarizeMethod` (`stuff|map_reduce`), per-stage overrides (`mapStage`, `reduceStage`, `synthesisStage` — each `inherit|ollama|cloud`), Makalah overrides (`makalahOutlineStage`, `makalahSectionStage`, `makalahThinking` default off, `makalahNumPredict` default 3072, clamped 256–16384). `lib/ollama/detect.ts` powers Settings → Auto-detect. Keys: AES-GCM at rest (`lib/ai/keys.ts`, `ai_credentials` owner-only RLS), never `NEXT_PUBLIC_*`.

### 1.6 Retrieval (RAG)

`retrieveContext()` (`src/lib/rag/retrieve.ts`) fuses three legs over RLS-gated server RPCs:

1. **FTS leg** — `fts_search_chunks` (`websearch_to_tsquery` + `ts_rank_cd`, approved-only).
2. **Vector leg** — `vector_search_chunks` (cosine `<=>`, approved-only); query embedded locally (`nomic-embed-text`, 768d) or via server embedding depending on `embedMode`. Embedding failure degrades to FTS/BM25-only with a surfaced diagnostic, never a silent wrong answer.
3. **BM25 leg** — Okapi BM25 (`src/lib/rag/bm25.ts`) scored over the candidate pool in-browser.
4. **Fusion** — Reciprocal Rank Fusion, k=60 (`fusion.ts`), over `max(topN·3, 24)` candidates; optional `scopeIds` restriction (scoped ask / compare / per-section retrieval).
5. **Rerank** — cross-encoder reranker (`rerank.ts`, LLM rerank available but off by default) down to `topN` (8, or 12 with Broad).

Strict grounding is the default: with zero passages and hybrid off, Ask returns a diagnostic "couldn't find anything" message (approval status, OCR hint, embedding diagnostics, FTS/vector/BM25 counts) instead of spending a model call. Hybrid `low→maximum` is prompt-level grounding instructions with an on-screen hallucination disclaimer.

### 1.7 Data, auth, realtime

Migration `0001_init.sql`: profiles, workspaces, workspace_members, documents (+`fts` tsvector, `status` pending/approved/rejected), sources, source_citations, authors, document_authors, collections, document_collections, tags, document_tags, research_projects, research_project_documents, research_queries, claims, citations, evidence_items, annotations, research_trail, saved_searches, document_chunks (+`fts`), document_embeddings (`vector(768)`, HNSW cosine), chats, chat_messages (`metadata_json`), chat_imports, ai_credentials. Domain columns ported 1:1 from the old `storage/sqlite.py`. `0002_storage.sql`: private `documents` bucket, `<workspace_id>/` prefix policies. `0003_rls_hardening.sql`, `0004_deletion_requests.sql` (one pending request per chat, RLS-enforced). Realtime publication (run once): workspace_members, documents, chats, chat_imports, research_projects, research_trail.

Auth/orz rules (enforced): `MAX_ALLOWED_MEMBERS = 10` clamped server-side (members POST, limit PATCH, DB CHECK). Kick = `status='removed'` + `auth.admin.signOut(userId)`; no account hard-delete. Chat RLS: SELECT workspace-visible; INSERT/UPDATE/DELETE owner-only (`chat.owner_id = auth.uid()`).

### 1.8 Constraints (enforced)

- No FastAPI/SQLite/Chroma/filesystem source of truth. No `pfolder/`, `library.db`, `chroma_db/`.
- Vercel never calls user localhost — `OllamaProvider` runs in-browser only.
- BYOK keys: AES-GCM at rest (`lib/ai/keys.ts`, `ai_credentials` owner-only RLS), never `NEXT_PUBLIC_*`.
- Inference settings: `InferenceContext` (localStorage). Server records only `{provider, model}` in `message.metadata_json`.
- `MAX_ALLOWED_MEMBERS = 10` clamped server-side (members POST, limit PATCH, DB CHECK).
- Kick: `status='removed'` + `auth.admin.signOut(userId)`; no account hard-delete.
- Chat RLS: SELECT workspace-visible; INSERT/UPDATE/DELETE owner-only (`chat.owner_id = auth.uid()`).

## 2. Capabilities

### 2.1 Library (`/`)

Workspace document grid with collections/tags/year/type filters, stats, document detail (`DocDetail`), file serving from the private Storage bucket, related-documents (citation graph, shared authors/topics, averaged-embedding semantic), reference extraction with fuzzy resolution, annotations, legal refresh + cited/citing cases. Uploads land as `pending`; the approval queue lives in Admin.

### 2.2 Search (`/search`)

Grouped hybrid search over the same RRF pipeline, saved searches (create/run/delete). Search needs only `nomic-embed-text`; generation models are each member's choice.

### 2.3 Research (`/research`)

Five modes sharing one chat stream, per-device conversation history (`ChatContext`: `wb_conversations_v1`, active id, memory cutoffs; legacy keys migrated on first run):

- **Ask** — streaming (Ollama tokens / cloud chunk-simulated), thinking box (Ollama `think` + `<think>`-parse fallback), Memory toggle (last 6 messages of *this* conversation as context; "clear memory" sets a cutoff, visible chat unchanged), Broad (topN 12), Hybrid selector, per-message Regenerate / Copy / Edit-question, stop-keeps-partial, non-stream fallback on transport failure.
- **Compare** — per-document retrieval (top 6 each), per-source labeled answer.
- **Summarize** — full 3-stage pipeline (MAP per-chunk fact extraction → REDUCE recursive consolidation → SYNTHESIS doc-type-aware narrative) plus a deterministic verbatim-fact regex layer (percentages, dates, sample sizes, Indonesian legal citations incl. Pasal/UU/putusan patterns, data-source keywords) appended as a verified section; `[THIS WORK]/[CITED]` tags and literal `\n` artifacts stripped. Method toggleable in Settings (`stuff` single-pass vs `map_reduce`). Export PDF opens a print view (Save as PDF); Export HTML downloads a styled file; arm-toggle flow preserved.
- **Matrix** — per-doc STRICT-JSON extraction via the member's model; CSV/MD/XLSX (SheetJS) client-side.
- **Synthesis** — agreement / disagreement / gaps / claims-by-support across ≥2 docs with per-source attribution.

Chat semantics (publish gallery model): **Shared chats** is read-only — nobody starts or continues a conversation there. **Publish**: Research history drawer → Publish ↑ (content + sources + thinking + model into `metadata_json`). **Import**: gallery → Open in Research, or drawer → Shared → Import ↓ (new local conversation; the member's own model continues it). **Delete**: owner files a `chat_deletion_requests` row; admin approves (deletes chat + messages, keeps request as audit) or rejects.

### 2.4 Makalah (`/makalah`)

Deterministic academic-paper drafting pipeline (Indonesian `makalah` structure: BAB I Pendahuluan → BAB II Pembahasan → BAB III Penutup). The LLM never owns control flow — every call is a pure function (fixed input → fixed JSON, no tools, no memory of other calls); retrieval, validation, loops, and rendering are app code. Engine: `src/lib/wb/makalah.ts` (+ prompt builders co-located); facade: `api.makalah*`; state: `MakalahContext` (`wb_makalah_drafts_v1`, active id); UI: `/makalah` 4-step wizard + `MakalahHistoryPanel`; model routing: `makalahOutlineStage` / `makalahSectionStage` / `makalahThinking` / `makalahNumPredict` in Settings.

- **Mode A (outline proposes, human approves):** 1 LLM call over topic + language + level + source summaries (abstract or first chunk, ≤600 chars) + template constraints (required chapters, min/max subsections). Proposed `likely_sources` are sanitized to exact selected-doc ids (hallucinated ids dropped; the prompt additionally orders exact copying). Editable tree (reorder, add/remove, per-subsection source chips); nothing proceeds until Approve.
- **Mode B (user structure):** same schema authored by hand; empty `source_ids` fall back to all selected docs at retrieval time. Both modes converge on one approved outline.
- **Section loop (1–2 LLM calls per subsection):** `query = subsection + chapter + topic` → `retrieveContext` top 8 → keep 4 passages → section call (target words, citation style, JSON-only) → code validator. Thinking runs ONLY here — never outline, never claim-check. When on, drafting is two-phase: deliberate with thinking at the configured level and `num_predict` == thinking budget (a hard cap, so the trace can never eat the answer; a valid early JSON draft short-circuits), then answer cold with the full output cap and the trace injected as context. Sequential with progress, stop keeps partials, per-section regenerate + text edit + on-demand claim check.
- **Anti-leakage attribution:** passages reach the model labeled with short opaque aliases (`S1`, `S2` — never raw UUIDs, which read as citation keys and get pasted into prose), with an explicit Bad/Good negative example in the prompt; citations map back to real ids on return (unknown aliases survive so the validator flags them). A regex strip layer (`stripLeakedCitations`: UUID shapes, `(S1, p./h./halaman N)` echoes in both bracket and paren form, `(Author et al., YYYY)` echoes — while preserving legit refs like `(UUD 1945)`) plus exact title-echo stripping (`stripTitleEchoes`, long titles only) runs before anything reaches the UI.
- **Validation (code, spec §6 steps 1–3):** structure completeness, citation-source integrity (exact id match — hallucinated ids rejected and shown), reference completeness. Optional step-4 claim-support classifier: one paragraph + its cited passages → `supported|not_supported` + reason, no document memory.
- **JSON hardening:** explicit `think:false` (see §1.5), fence/prose stripping, greedy-brace extraction, trailing-comma repair, one bounded correction retry showing the model its own bad output; empty/think-only output fails fast with an actionable message. Final section fallback preserves raw text with **zero** citations plus an `[unstructured-fallback]` marker that forces a quality-report entry — provider/network errors are never salvaged, they stay hard errors.
- **Bibliography:** deterministic, from stored metadata (APA-ish plain text via `docToCslItem` + `renderCitationPlain`; no-author items lead with the title, trailing periods de-duplicated; missing titles fall back to filename, then id stub — a cited source always yields an entry). Entries that still look broken (leading `(year)`, `..`) are flagged as `malformed_references` in the quality report instead of silently shipping. References auto-top-up (`ensureReferences`) on preview/export/copy, so per-section drafting can never leave Daftar Pustaka silently empty.
- **Gaps are drafting-only:** the `gaps` field is written in the paper's language and shown in the drafting cards + quality signals, but never ships in the PDF, preview, or Markdown copy.
- **Quality report:** structure complete, citation integrity %, unsupported list (incl. salvage flags and generation errors), missing/unused references.
- **History:** drafts autosave debounced into the bound draft (setup, outline, all section outputs/passages/verdicts, references, step); refresh-safe; mid-flight statuses reset to idle on load; drawer lists title/progress/date with open/delete; deleting the open draft falls back instead of stranding the UI.
- **Export:** PDF via print view (cover, TOC, sections with inline `[title, h. X]` cites, gap notes, Daftar Pustaka/References by language — QA report stays in-UI by design), plus Copy-as-Markdown.

### 2.5 Projects (`/projects`)

Research projects with member documents, claims + citations + quoted evidence, recorded queries (ask auto-logs when a `project_id` is passed), OpenAlex-backed flows. Detail view at `/projects/[id]`.

### 2.6 Reader (`/reader/[id]`)

Per-document reading view over the same hydrated data + chunks/annotations substrate.

### 2.7 Upload (`/upload`)

Browser-side extraction (pdfjs-dist, DOCX via OpenXML DOM, XLSX/XLS via SheetJS, PPTX slide XML, RTF control-stripper, TXT/MD/CSV/HTML), OpenAlex metadata proposal with human confirm, dedup + classification + 4700/880 chunking, local/server embedding, `pending` status for admin approval. Live phases in `UploadFlow`.

### 2.8 Citations & legal

citeproc-js in-browser with 7 vendored styles + en-US locale (`public/csl/`), repo fetch-by-id, custom XML, per-device default (old server-wide setting became local). Serializers: BibTeX/RIS/CSL-JSON import (with parsers in `lib/importing/`) and export, bibliography rendering. Legal: deterministic extraction (court/case/parties/date, PUU + Pasal patterns, citation edges) plus model-backed legal-analysis/extract with the original prompts; Indonesian putusan handling is first-class (Duduk Perkara → Amar Putusan structures, exact Pasal/ayat preservation).

### 2.9 Settings (`/settings`)

Chat card (provider/model/ctx/temp/embed mode/autodetect/cloud BYOK with live model list), Summarization pipeline card (method + map/reduce/synthesis overrides), **Makalah pipeline card** (outline/section overrides, thinking toggle, output cap), Citation card, Import/Export card, Workspace card, Model-configuration card, Privacy, Storage (Supabase info + workspace JSON export), shortcuts reference. Everything inference-shaped is device-local.

### 2.10 Admin (`/admin`)

Member management + limit, kick, upload approval queue, chat-deletion approvals. Admin-only nav; bootstrap via `/register` + `ADMIN_REGISTRATION_KEY`.

## 3. Honest behavior deltas vs the original local app

UI is identical; where the old backend did something the new architecture cannot, the port does the faithful equivalent:

- **Ask streaming**: Ollama streams tokens via `/api/chat` NDJSON (same SSE-style UI: status line, thinking box, stop-keeps-partial). Cloud answers are chunk-simulated into the same streaming UI.
- **Thinking**: explicit `think` flag for Ollama + `<think>` parsing fallback; cloud models show no thinking box. Native-reasoning models are force-disabled unless the toggle/stage enables them (live-verified on qwen3.5:4b).
- **Memory**: per-conversation prior messages sent as context (Memory toggle); "Clear memory" sets a cutoff — visible chat unchanged. (Old: server-side per-session memory.)
- **Hybrid low→maximum**: prompt-level grounding instructions (old: server-side context mixing). Disclaimer UI unchanged.
- **Summarize**: full 3-stage pipeline (MAP per-chunk fact extraction → REDUCE recursive consolidation → SYNTHESIS doc-type-aware narrative) + deterministic verbatim-fact regex layer (percentages, dates, sample sizes, Indonesian legal citations, data-source keywords) appended as a verified section; cleanup strips [THIS WORK]/[CITED] tags and literal \\n artifacts. Method toggleable in Settings (stuff = single-pass when fits ctx, map_reduce = always full pipeline). Export PDF opens a print view (Save as PDF); Export HTML downloads a styled file. Arm-toggle flow preserved.
- **Matrix**: per-doc STRICT-JSON extraction via your model; CSV/MD/XLSX (SheetJS) client-side.
- **Makalah**: new in this version (no predecessor) — see §2.4.
- **Upload**: PDF parsing via pdfjs-dist in-browser, DOCX via JSZip OpenXML DOM parser, XLSX/XLS via SheetJS, PPTX via JSZip slide XML parser, RTF via regex control stripper; TXT/MD/CSV/HTML covered. OpenAlex via browser fetch (CORS-open). Confirm → Storage + rows + embeddings → `pending` (admin approval in Admin dashboard, approval queue included).
- **Citations**: citeproc-js in-browser with the same 7 vendored styles + en-US locale; fetch-by-id from the CSL repo; custom XML; default style — all per-device localStorage (old: server-wide setting).
- **Related**: same 4 labeled groups (citation graph, shared authors, shared topics, semantic via averaged chunk embeddings + RPC).
- **Refs**: `[...]` extraction + fuzzy ≥0.55 match, same UI.
- **Legal**: deterministic refresh (court/case/parties/date + citation edges + resolve) ported 1:1; legal-analysis/extract run through your model with the original prompts.
- **Settings**: Chat card → this-device inference (provider/model/ctx/temp/embed mode/cloud key/autodetect); Makalah card → stage overrides + thinking + output cap; Import/Export fully client-side (imports become pending records); Watch-folder card replaced by Workspace card (no daemon, by design); Storage card → Supabase info + workspace JSON export (replaces SQLite backup file); Privacy card rewritten for the new model.
- **Auth shell**: `/login`, `/register` (member + admin bootstrap), route guard + sidebar sign-out + admin-only Admin nav. `/dashboard` and `/library` redirect to `/` (library is home, as in the original).

## 4. Ports (Python → TypeScript)

| Old | New |
|---|---|
| `core/ingestion/deduplication.py` | `lib/ingestion/dedup.ts` |
| `core/ingestion/classifier.py` | `lib/ingestion/classify.ts` |
| chunking (`ing
...[truncated 2085 chars]