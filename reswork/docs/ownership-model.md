# Ownership model (workspace-level shared curation)

Status: observed behavior, documented as the single coherent model (Task J).
Any change to ownership semantics must update schema + RLS + API guards +
this file together — never one layer alone.

## The model in one paragraph

Ownership is **workspace-level, not user-level**, for library and research
content: any active workspace member may create, read, and modify shared
rows, with **role gates on destructive / publishing transitions**
(documents approve/delete, member kick, workspace limit). The only
**strictly user-owned** data is `ai_credentials` (BYOK keys), private chats,
and profiles. `uploaded_by` / `created_by` columns are **attribution, not
ownership gates** — except for pending documents (see below).

## Rules per area

| Area | Member | Admin | Notes |
| --- | --- | --- | --- |
| documents (approved) | read | read | Members also read own pending rows |
| documents (pending, own) | insert / update | full | Insert forces `status='pending'`, `uploaded_by=self` (RLS) |
| documents status flip / delete | denied | allow | Approve route + `documents_update`/`_delete` enforce admin |
| sources, authors, collections, tags + joins | full CRUD | full CRUD | Shared tagging/curation; no owner gate |
| research_projects, claims, citations, evidence, annotations, saved_searches | full CRUD | full CRUD | Workspace-wide curation |
| research_trail, research_queries | insert + read | + update/delete | Append-only history for members (migration 0006) |
| document_chunks | insert + read | + update/delete | Ingest inserts; repair is admin-only (0006) |
| document_embeddings | read (+insert via ingest path) | + update | No `workspace_id`; membership resolves via parent chunk |
| chats (workspace-visible) | read | read | Visibility `workspace` or owner or admin |
| chats (private) | owner-only | read via admin override on select | Insert/update owner-only; delete owner-or-admin |
| chat_messages | owner writes | admin delete | Reads follow parent chat visibility (tightened by migration 0008 — membership-only before; private/stored chats leaked to any member holding the chat id) |
| ai_credentials | own rows only | own rows only | `(user_id, provider)` PK (migration 0005); admins have NO access |
| profiles | own write; co-member read | — | |
| storage `documents/<ws>/…` | read + upload to own ws prefix | + delete | Prefix matched exactly (0006); signed URLs only after RLS row check |
| workspace_members | read | manage | Admin-only write; kick additionally invalidates session server-side |

## Invariants (enforced in RLS + API guards + probe suite)

1. No cross-workspace read or write through any member path
   (`src/security/rls-probe.test.ts` covers User A / User B / anonymous).
2. No member path flips `documents.status` or deletes a document.
3. No member (or admin) reads another user's `ai_credentials` rows.
4. `created_by` / `uploaded_by` are set server-side from the session
   (trail route, approve route) or RLS-checked — never trusted from the client.
5. Service-role bypass exists only for bootstrap/admin operations that RLS
   cannot express (register-admin, kick invalidation); never for user reads.

## Explicitly undecided (product decisions, NOT implemented)

- Per-item ownership (e.g. "only the creator may edit/delete this claim").
- Owner-only delete on shared tables (today any member may delete any
  collection/claim/project — accepted as shared curation).
- Approval workflow for non-document content.
- Transfer of the `admin_id` / workspace ownership role.

Implementing any of these requires: schema (owner columns), RLS policy
changes, API authorization updates, UI gating (never an RLS-only change —
working buttons must not become RLS errors), probe coverage, and a migration.
See migration 0006's header for why shared tables were deliberately left open.
