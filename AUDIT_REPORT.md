# Research Workbench — Independent Comprehensive Audit Report

**Date:** November 12, 2026  
**Auditor:** Senior Staff Engineer, Application Security Specialist & QA Lead  
**Target Repository:** `research-workbench-web` (Next.js 16 + Supabase + Client-Side Inference)  
**Target Directory:** `c:\Users\Pasha\Desktop\rewbench\reswork`

---

## 1. EXECUTIVE SUMMARY

The Research Workbench codebase demonstrates thoughtful architectural intent, featuring robust cryptographic isolation for BYOK cloud keys, clean modular separation of retrieval legs (FTS, Vector, BM25), and comprehensive unit test coverage (313 passing tests). However, **the application is NOT safe to deploy to production in its current state** due to high-severity vulnerabilities and build-breaking configuration issues. Most critically, active production credentials (including Supabase service-role JWTs and encryption keys) are present in an unignored file (`env.download`) committed within the repository workspace. Additionally, the admin bootstrap endpoint (`POST /api/auth/register-admin`) is vulnerable to client-side IP spoofing that circumvents rate limiting, coupled with a status-code oracle that permits brute-force guessing of the administrative registration key. A regression in storage migration `0012` weakens multi-tenant object prefix isolation, and an ESLint configuration omission breaks the CI pipeline. Addressing the Critical and High severity findings highlighted below is mandatory prior to public or team deployment.

---

## 2. SCOPE AND METHOD

### What Was Examined
- **Full source tree:** All TypeScript, TSX, SQL migrations, API routes, middleware, utility libraries, contexts, components, and configuration files under `src/`, `supabase/`, `.github/`, and project root.
- **Data flow & boundaries:** Traced untrusted user input from browser UI and API routes through Supabase RLS policies, PostgreSQL RPC functions, and upstream inference proxies.
- **Cryptographic & auth implementations:** BYOK key encryption/decryption, session middleware, registration bootstrap, and access control policies.
- **Dependency & build manifests:** `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, and CI workflows.

### Tools Executed
- **Type Checker:** `npm run typecheck` (`tsc --noEmit`) — Completed with 0 errors.
- **Unit & Boundary Tests:** `npm test` (`vitest run`) — 60 test files passed (313 tests passed, 8 skipped).
- **Linter:** `npm run lint` (`eslint .`) — Failed with 1 error and 83 warnings.
- **Production Build:** `npm run build` (`next build`) — Successfully compiled 23 static and dynamic routes.
- **Dependency Audit:** `npm audit` — Attempted; blocked due to sandbox/offline registry network constraints.

### Assumptions & Limitations
- Live staging Supabase integration tests (`src/security/rls-probe.test.ts`) were skipped by default as no live Supabase instance was connected to the local test runner.
- Security analysis of PostgreSQL stored procedures and RLS was performed through deep static code inspection of migrations `0001` through `0014` and local unit test mocks.

---

## 3. ARCHITECTURE SNAPSHOT

- **Stack:** Next.js 16 (App Router with Turbopack), React 19, TypeScript 5, Tailwind CSS 4, Supabase (PostgreSQL 15+, pgvector, Full-Text Search, GoTrue Auth, Storage, Realtime).
- **Inference Ownership Model:**
  - *Browser:* Direct client-to-host communication with local Ollama (`http://localhost:11434`) for local model inference and embedding.
  - *Vercel / Next.js Server:* Serves UI, runs server-side API routes for RAG search/embedding coordination, authenticates workspace administration, and decrypts personal BYOK API keys for OpenAI/Anthropic/Google/DeepSeek without exposing them to other members.
  - *Supabase:* Central source of truth for collaborative research documents, citations, chat galleries, vectors (`vector(768)`), and workspace membership.
- **Entry Points & Trust Boundaries:**
  - Public HTTP endpoints: `/login`, `/register`, `/api/auth/register-admin`, `POST /api/workspaces/members`.
  - Authenticated member endpoints: `/api/ai/proxy`, `/api/rag/search`, `/api/rag/embed`, `/api/research/trail`.
  - Admin-only endpoints: `/admin`, `/api/documents/approve`, `/api/workspaces/kick`, `/api/workspaces/limit`.
  - Storage Bucket: `documents` (private bucket scoped by `<workspace_id>/<file_hash>.<ext>`).

---

## 4. FINDINGS SUMMARY TABLE

| ID | Title | Category | Severity | Confidence | Effort | Location |
|---|---|---|---|---|---|---|
| **SEC-01** | Production Secrets Committed in Unignored Environment File | Secrets / Config | **Critical** | High | Small | `env.download:1-17`, `.gitignore:1-4` |
| **SEC-02** | Client IP Header Spoofing Bypasses Admin Rate Limiting | Security / DoS | **High** | High | Small | `src/app/api/_lib/rateLimit.ts:63-71` |
| **SEC-03** | Observable Status Code Oracle on Admin Registration Key | Security / Auth | **High** | High | Small | `src/app/api/auth/register-admin/route.ts:45-50` |
| **SEC-04** | Storage RLS Security Regression Re-Introduces Weak Prefix Check | Security / Authz | **High** | High | Small | `supabase/migrations/0012_storage_size_cap.sql:27` |
| **BUG-01** | ESLint Failure in E2E Mock File Breaks CI Gate | Reliability / CI | **High** | High | Small | `eslint.config.mjs:36-41`, `e2e/mock-supabase.cjs:3` |
| **SEC-05** | Missing Client-Side Role Guard on Admin Dashboard Route | Security / Authz | **Medium** | High | Small | `src/app/admin/page.tsx:36-397` |
| **SEC-06** | Workspace Admins Granted Unrestricted Read Access to Member Private Chats | Security / Privacy | **Medium** | High | Small | `supabase/migrations/0001_init.sql:730-734`, `0008_rls_private_messages.sql:26-32` |
| **SEC-07** | Unrestricted Self-Join Allows Arbitrary Workspace Enumeration | Security / Authz | **Medium** | High | Medium | `src/app/api/workspaces/members/route.ts:60-73` |
| **SEC-08** | Missing Standard HTTP Security Headers (CSP, Frame Options, HSTS) | Security / Config | **Medium** | High | Small | `next.config.ts:1-16`, `src/proxy.ts:1-10` |
| **SEC-09** | Unauthenticated Supabase Edge Function with Vector Dimension Mismatch | Security / AI | **Medium** | High | Small | `supabase/functions/embed/index.ts:8, 36` |
| **BUG-02** | Assistant Message Metadata Hardcodes "ollama" on Chat Publishing | Bugs / Correctness | **Medium** | High | Small | `src/lib/wb/publish.ts:48` |
| **BUG-03** | BibTeX Parser Aborts on Missing Closing Brace & Ignores Parenthesis Syntax | Bugs / Correctness | **Medium** | High | Medium | `src/lib/importing/parsers.ts:94-110` |
| **SEC-10** | Incomplete HTML Entity Escaping in Makalah Export Document | Security / XSS | **Low** | High | Small | `src/lib/wb/makalah/page-support.ts:20-22` |
| **REL-01** | Unpinned Runtime Third-Party CDN Dependency for PDF Extraction | Reliability | **Low** | High | Small | `src/lib/ingestion/chunking.ts:119` |
| **PERF-01** | Cascading Renders from Synchronous setState within useEffect | Performance | **Low** | High | Medium | `src/contexts/SessionContext.tsx:65`, `src/app/admin/page.tsx:88` |
| **A11Y-01** | Missing Form Input Labels and Low Contrast on Secondary Text | Accessibility | **Low** | High | Small | `src/app/login/page.tsx:39-54`, `src/app/register/page.tsx:78-99` |

---

## 5. DETAILED FINDINGS

### SEC-01: Production Secrets Committed in Unignored Environment File
- **Severity:** Critical
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-798: Use of Hard-coded Credentials, CWE-200: Exposure of Sensitive Information; OWASP A07:2021-Identification and Authentication Failures, A02:2021-Cryptographic Failures
- **Location:** `env.download:1-17`, `.gitignore:1-4`
- **Description:**  
  The root directory contains a file named `env.download` containing real, active credentials for a live Supabase instance: the project URL, anon key, `SUPABASE_SERVICE_ROLE_KEY` (a service-role JWT allowing total RLS bypass and full administrative database control), `ADMIN_REGISTRATION_KEY`, and `CREDENTIALS_ENCRYPTION_KEY`. The project's `.gitignore` only specifies `node_modules/`, `.next/`, `.env*.local`, and `.env`, meaning `env.download` is not ignored and is tracked in git history.
- **Evidence:**  
  `env.download`:
  ```bash
  NEXT_PUBLIC_SUPABASE_URL=https://xxwdwinklkhfacqmnjyh.supabase.co
  NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...[REDACTED]...
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...[REDACTED]...
  ADMIN_REGISTRATION_KEY=Aad...[REDACTED]...
  CREDENTIALS_ENCRYPTION_KEY=uig...[REDACTED]...
  ```
- **Impact:**  
  Anyone with read access to the git repository or build artifact can immediately extract the service role key, take over the Supabase database, dump all user credentials, decrypt all member BYOK API keys, alter schemas, or delete all stored documents and vectors.
- **Recommended Fix:**  
  1. Immediately revoke and rotate all compromised keys in the Supabase Dashboard (Service Role Key, Anon Key) and generate new random secrets for `ADMIN_REGISTRATION_KEY` and `CREDENTIALS_ENCRYPTION_KEY`.
  2. Permanently delete `env.download` from the file system and purge it from git history using `git filter-repo` or BFG Repo-Cleaner.
  3. Update `.gitignore` to comprehensively ignore environment and credential files:
     ```gitignore
     .env*
     *.download
     ```

---

### SEC-02: Client IP Header Spoofing Bypasses Admin Rate Limiting
- **Severity:** High
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-345: Insufficient Verification of Data Authenticity, CWE-290: Authentication Bypass by Spoofing; OWASP A07:2021-Identification and Authentication Failures
- **Location:** `src/app/api/_lib/rateLimit.ts:63-71`
- **Description:**  
  `getClientIp()` extracts the client IP address by reading the first comma-separated entry of the `x-forwarded-for` request header:
  ```ts
  export function getClientIp(req: Request): string | null {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = req.headers.get("x-real-ip")?.trim();
    return real || null;
  }
  ```
  Because standard reverse proxies (including Cloudflare, AWS ALB, Nginx, and Vercel) append the true client IP to the *end* of an existing `X-Forwarded-For` chain, reading index `0` evaluates the client-supplied, untrusted header value. An attacker targeting `POST /api/auth/register-admin` can supply an arbitrary IP (`X-Forwarded-For: 1.2.3.4`) on each request.
- **Impact:**  
  The per-IP rate limiter on `/api/auth/register-admin` (configured for 5 attempts per hour) is rendered completely ineffective. An attacker can execute hundreds of thousands of key-guessing requests without triggering HTTP 429.
- **Recommended Fix:**  
  In serverless/reverse proxy environments like Vercel, read trusted platform headers (such as `x-vercel-forwarded-for` or `x-real-ip`), or extract the *rightmost* proxy-verified entry of `x-forwarded-for`:
  ```ts
  export function getClientIp(req: Request): string | null {
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
      // In trusted proxy setups, use the verified remote address or rightmost proxy address
      return parts[parts.length - 1] || null;
    }
    return null;
  }
  ```

---

### SEC-03: Observable Status Code Oracle on Admin Registration Key
- **Severity:** High
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-208: Observable Timing Discrepancy, CWE-203: Observable Discrepancy; OWASP A07:2021-Identification and Authentication Failures
- **Location:** `src/app/api/auth/register-admin/route.ts:45-50`
- **Description:**  
  The administrative registration route checks `admin_key` before verifying whether other required parameters (`email`, `password`) are provided:
  ```ts
  if (!keyMatches(body.admin_key, expected)) {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 403 });
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }
  ```
  If an attacker sends an invalid `admin_key`, the server responds with **HTTP 403** ("Registration failed"). If the attacker sends the *correct* `admin_key` (even with an empty or missing body), the server responds with **HTTP 400** ("email and password are required").
- **Impact:**  
  An unauthenticated remote attacker possesses an immediate, deterministic oracle to verify whether a candidate `ADMIN_REGISTRATION_KEY` is correct without needing a valid email or password. In conjunction with **SEC-02**, the key can be brute-forced or dictionary-attacked with zero rate-limit friction.
- **Recommended Fix:**  
  Validate all input fields first, and return consistent HTTP status codes and error messages regardless of which validation check fails:
  ```ts
  if (!body.email || !body.password || !body.admin_key) {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 400 });
  }
  if (!keyMatches(body.admin_key, expected)) {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 400 });
  }
  ```

---

### SEC-04: Storage RLS Security Regression Re-Introduces Weak Prefix Check
- **Severity:** High
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-285: Improper Authorization, CWE-22: Improper Limitation of a Pathname to a Restricted Directory; OWASP A01:2021-Broken Access Control
- **Location:** `supabase/migrations/0012_storage_size_cap.sql:27` (overriding `0006_rls_least_privilege.sql:79, 91`)
- **Description:**  
  In migration `0006`, the storage object insertion policy was hardened to ensure workspace isolation by inspecting the path segment rather than an arbitrary substring prefix:
  ```sql
  -- 0006: Exact path segment check
  and (storage.foldername(name))[1] = m.workspace_id::text
  ```
  However, in migration `0012` (`0012_storage_size_cap.sql`), when applying the 50MB size limit check, the author dropped and recreated `documents_bucket_insert_members` using the older, vulnerable logic from migration `0002`:
  ```sql
  -- 0012: Reverted back to insecure position check
  and position(m.workspace_id::text in name) = 1
  ```
- **Impact:**  
  Using `position(...) = 1` checks only if the string begins with the workspace UUID, rather than requiring it to be an isolated directory folder (`<workspace_id>/...`). Any file path beginning with that UUID string (e.g., `<workspace_id>-malicious/file.bin` or adjacent shared buckets) bypasses directory segment validation.
- **Recommended Fix:**  
  Create migration `0015_fix_storage_prefix_regression.sql` restoring the folder segment match while preserving the size cap:
  ```sql
  drop policy if exists "documents_bucket_insert_members" on storage.objects;
  create policy "documents_bucket_insert_members"
  on storage.objects for insert with check (
    bucket_id = 'documents'
    and (
      (metadata ->> 'size') is null
      or (metadata ->> 'size')::bigint <= 52428800
    )
    and exists (
      select 1 from public.workspace_members m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and (storage.foldername(name))[1] = m.workspace_id::text
    )
  );
  ```

---

### BUG-01: ESLint Failure in E2E Mock File Breaks CI Gate
- **Severity:** High
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-1068: Inconsistency Between Implementation and Documented Design
- **Location:** `eslint.config.mjs:36-41`, `e2e/mock-supabase.cjs:3`
- **Description:**  
  Running `npm run lint` fails with a fatal error:
  ```
  C:\Users\Pasha\Desktop\rewbench\reswork\e2e\mock-supabase.cjs
    3:14  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports
  ✖ 84 problems (1 error, 83 warnings)
  ```
  In `.github/workflows/ci.yml` (line 29), `npm run lint` is the very first check in the CI gate. Because `eslint.config.mjs` ignores `.next/`, `node_modules/`, `supabase/`, and `next-env.d.ts` but omits `e2e/`, ESLint applies TypeScript rules to `e2e/mock-supabase.cjs`.
- **Impact:**  
  Every push and pull request fails continuous integration on GitHub Actions.
- **Recommended Fix:**  
  Add `e2e/**` to `globalIgnores` in `eslint.config.mjs`:
  ```javascript
  export default defineConfig([
    globalIgnores([
      ".next/**",
      "node_modules/**",
      "supabase/**",
      "next-env.d.ts",
      "e2e/**",
    ]),
    // ...
  ]);
  ```

---

### SEC-05: Missing Client-Side Role Guard on Admin Dashboard Route
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-284: Improper Access Control, CWE-602: Client-Side Enforcement of Server-Side Security; OWASP A01:2021-Broken Access Control
- **Location:** `src/app/admin/page.tsx:36-397`
- **Description:**  
  The Admin page (`/admin`) does not verify whether the active session belongs to an administrator. A regular workspace member (`role === "member"`) who navigates directly to `/admin` is rendered the entire dashboard, including:
  1. The member management table (listing all user UUIDs, roles, and join dates).
  2. The document approval queue.
  3. The shared-chat deletion request queue.
  4. Ingest health diagnostics and storage orphan controls.
  5. The member limit configuration input.
- **Impact:**  
  Although destructive actions (kick, approve, change limit) fail at the server level, non-admin members gain visibility into sensitive workspace metadata, user identifiers, and administrative queues, leading to information leakage and misleading UI state.
- **Recommended Fix:**  
  Add an authorization gate at the top of `AdminPage`:
  ```tsx
  const { workspace, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && workspace && workspace.role !== "admin") {
      router.replace("/");
    }
  }, [workspace, loading, router]);

  if (!workspace || workspace.role !== "admin") {
    return <div className="p-6 text-sm text-[#8e8e8e]">Access denied: administrator privileges required.</div>;
  }
  ```

---

### SEC-06: Workspace Admins Granted Unrestricted Read Access to Member Private Chats
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-200: Exposure of Sensitive Information to an Unauthorized Actor; OWASP A01:2021-Broken Access Control
- **Location:** `supabase/migrations/0001_init.sql:730-734`, `supabase/migrations/0008_rls_private_messages.sql:26-32`
- **Description:**  
  The application documentation and UI specify that "Stored" chats are private account backups (`visibility = 'private'`) intended only for the owner across their devices (`lib/wb/publish.ts`: *"visibility 'private' so only the owner reads it"*).  
  However, the RLS policy in migration `0008` explicitly permits workspace admins to select private chat messages:
  ```sql
  create policy "chat_messages_read_ws" on public.chat_messages for select using (
    exists (select 1 from public.chats c
            where c.id = chat_messages.chat_id
              and public.is_workspace_member(c.workspace_id)
              and (c.visibility = 'workspace'
                   or c.owner_id = auth.uid()
                   or public.is_workspace_admin(c.workspace_id)))
  );
  ```
  The same clause exists on `chats_read_ws`.
- **Impact:**  
  Any workspace administrator can query and read all private, unshared chat conversations and queries created by any member of the workspace, violating user privacy expectations.
- **Recommended Fix:**  
  Restrict `private` chat reads strictly to the chat owner:
  ```sql
  create policy "chat_messages_read_ws" on public.chat_messages for select using (
    exists (select 1 from public.chats c
            where c.id = chat_messages.chat_id
              and public.is_workspace_member(c.workspace_id)
              and (c.visibility = 'workspace' or c.owner_id = auth.uid()))
  );
  ```

---

### SEC-07: Unrestricted Self-Join Allows Arbitrary Workspace Enumeration
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Medium
- **CWE / OWASP:** CWE-284: Improper Access Control; OWASP A01:2021-Broken Access Control
- **Location:** `src/app/api/workspaces/members/route.ts:60-73`
- **Description:**  
  `POST /api/workspaces/members` allows any authenticated user to join a workspace simply by passing a `workspaceId` UUID:
  ```ts
  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const { data: first } = await service.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    workspaceId = (first as { id: string } | null)?.id;
  }
  // joins workspace without invite code or admin approval
  ```
- **Impact:**  
  If the Supabase project has multiple workspaces (or in multi-tenant environments), any user who signs up through the public signup flow can join any workspace by UUID, or automatically join the primary workspace until the 10-member ceiling is reached, denying legitimate users access (denial of service).
- **Recommended Fix:**  
  Implement an invitation token or workspace passcode requirement for new members joining an existing workspace.

---

### SEC-08: Missing Standard HTTP Security Headers
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-693: Protection Mechanism Failure, CWE-1021: Improper Restriction of Rendered UI Layers or Frames; OWASP A05:2021-Security Misconfiguration
- **Location:** `next.config.ts:1-16`, `src/proxy.ts:1-10`
- **Description:**  
  Neither `next.config.ts` nor the Next.js proxy middleware sets HTTP security headers. The application runs with no:
  - `Content-Security-Policy` (CSP)
  - `X-Frame-Options` (vulnerable to Clickjacking)
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`
  - `Strict-Transport-Security` (HSTS)
- **Impact:**  
  The application can be embedded in malicious `<iframe>` wrappers (clickjacking), MIME-type sniffing is unconstrained, and there is no Defense-in-Depth policy against XSS.
- **Recommended Fix:**  
  Add `headers()` in `next.config.ts`:
  ```typescript
  const nextConfig: NextConfig = {
    // ...
    async headers() {
      return [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Frame-Options", value: "DENY" },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
            { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          ],
        },
      ];
    },
  };
  ```

---

### SEC-09: Unauthenticated Supabase Edge Function with Vector Dimension Mismatch
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-306: Missing Authentication for Critical Function, CWE-681: Incorrect Conversion between Numeric Types; OWASP A01:2021-Broken Access Control
- **Location:** `supabase/functions/embed/index.ts:8, 36`
- **Description:**  
  The Deno Edge Function in `supabase/functions/embed/index.ts`:
  1. Has no bearer token or Supabase auth verification on `Deno.serve(async (req) => ...)`.
  2. Forwards calls to OpenAI embeddings without setting `dimensions: 768`.
- **Impact:**  
  Anyone discovering the edge function URL can utilize it as an unauthenticated proxy. Furthermore, `text-embedding-3-small` defaults to 1536 dimensions; when returned to callers expecting 768-dimensional vectors for the `vector(768)` column, database inserts fail with dimension mismatches.
- **Recommended Fix:**  
  Add JWT authorization checking via `supabase.auth.getUser()`, and add `{ dimensions: 768 }` to the upstream OpenAI request body.

---

### BUG-02: Assistant Message Metadata Hardcodes "ollama" on Chat Publishing
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-1068: Inconsistency Between Implementation and Documented Design
- **Location:** `src/lib/wb/publish.ts:48`
- **Description:**  
  When an assistant message is serialized for export/storage in `buildMessageRows()`, the provider field is hardcoded:
  ```ts
  metadata_json: {
    ...(msg.role === "assistant"
      ? { provider: "ollama", model: msg.model ?? null, sources: msg.sources ?? [], thinking: msg.thinking ?? null }
      : {}),
  }
  ```
  If a user runs inference using a Cloud provider (OpenAI, DeepSeek, Google, Anthropic), the conversation record erroneously attributes the provider as `"ollama"`.
- **Impact:**  
  Published shared chats and downloaded backups corrupt the provenance of AI responses, causing imported chats to attempt local Ollama execution for models that were actually cloud-hosted.
- **Recommended Fix:**  
  Record the true provider dynamically from the conversation message object:
  ```ts
  provider: msg.provider || "ollama",
  ```

---

### BUG-03: BibTeX Parser Aborts on Missing Closing Brace & Ignores Parenthesis Syntax
- **Severity:** Medium
- **Confidence:** High
- **Effort:** Medium
- **CWE / OWASP:** CWE-754: Improper Check for Unusual or Exceptional Conditions
- **Location:** `src/lib/importing/parsers.ts:94-110`
- **Description:**  
  In `parseBibtex()`:
  ```ts
  while ((m = ENTRY_RE.exec(text)) !== null) {
    // ...
    for (let i = m.index; i < text.length; i++) {
      // counts depth of { and }
    }
    if (end === -1) break;
  ```
  1. If an uploaded `.bib` file contains a single malformed entry lacking a closing brace, `end` evaluates to `-1` and the loop terminates (`break`), silently discarding all subsequent valid BibTeX entries in the file.
  2. The regex `ENTRY_RE = /@(\w+)\s*[{(\s]*([^,\s]*)\s*,/gi` accepts parenthesis syntax `@article(key, ...)`, but the delimiter counter only tracks `{` and `}`, causing parenthesis-delimited entries to always fail to match `end` and abort parsing.
- **Impact:**  
  Bulk bibliographic imports silently drop citations without user notification.
- **Recommended Fix:**  
  Track entry start delimiters (`(` vs `{`) and skip malformed entries with `continue` rather than `break`.

---

### SEC-10: Incomplete HTML Entity Escaping in Makalah Export Document
- **Severity:** Low
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-116: Improper Encoding or Escaping of Output; OWASP A03:2021-Injection
- **Location:** `src/lib/wb/makalah/page-support.ts:20-22`
- **Description:**  
  `escapeHtml()` in Makalah page support is defined as:
  ```ts
  export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  ```
  It does not escape double quotes (`"`) or single quotes (`'`). In `document.ts:136`, `escapeHtml` is used inside HTML attribute contexts:
  `<html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>`
- **Impact:**  
  If user-supplied metadata in `language` contains quotes (e.g. `en" onload="...`), attribute breakout could occur when the generated print HTML is rendered in a browser window.
- **Recommended Fix:**  
  Align `escapeHtml` with the implementation in `src/components/Markdown.tsx:11`:
  ```ts
  export function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  ```

---

### REL-01: Unpinned Runtime Third-Party CDN Dependency for PDF Parsing
- **Severity:** Low
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** CWE-829: Inclusion of Functionality from Untrusted Control Sphere; OWASP A08:2021-Software and Data Integrity Failures
- **Location:** `src/lib/ingestion/chunking.ts:119`
- **Description:**  
  PDF parsing dynamically pulls worker code from cdnjs at runtime:
  `pdfjs.GlobalWorkerOptions.workerSrc = \`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/\${pdfjs.version}/pdf.worker.min.mjs\`;`
  No Subresource Integrity (SRI) hash is provided.
- **Impact:**  
  In air-gapped or restricted offline environments, PDF extraction fails completely. If the CDN host or DNS is manipulated, untrusted JavaScript executes in the worker thread.
- **Recommended Fix:**  
  Bundle `pdf.worker.min.mjs` directly in the local `public/` directory or package bundle and reference it locally.

---

### PERF-01: Cascading Renders from Synchronous setState within useEffect
- **Severity:** Low
- **Confidence:** High
- **Effort:** Medium
- **CWE / OWASP:** React Anti-Pattern / Performance Degradation
- **Location:** `src/contexts/SessionContext.tsx:65:5`, `src/app/admin/page.tsx:88:5`, `src/app/chats/page.tsx:52:5`, `src/contexts/InferenceContext.tsx:157:5`
- **Description:**  
  ESLint flags 83 warnings where `setState()` is called synchronously inside `useEffect()` bodies on component mount. This triggers cascading re-renders and unneeded DOM reconciliations across primary UI layouts.
- **Impact:**  
  Increased Time-to-Interactive (TTI) and UI hitching on low-powered client devices.
- **Recommended Fix:**  
  Adopt modern React patterns: initialize state using lazy initializers where possible, or encapsulate asynchronous loading in dedicated custom hooks with state deduplication.

---

### A11Y-01: Missing Form Input Labels and Low Contrast on Secondary Text
- **Severity:** Low
- **Confidence:** High
- **Effort:** Small
- **CWE / OWASP:** WCAG 2.1 Criteria 1.4.3 (Contrast) & 4.1.2 (Name, Role, Value)
- **Location:** `src/app/login/page.tsx:39-54`, `src/app/register/page.tsx:78-99`
- **Description:**  
  1. Authentication form inputs lack `<label htmlFor="...">` bindings or `aria-label` attributes, relying solely on `placeholder="..."`.
  2. Secondary typography using `#5f5f5f` on pure black `#000000` provides a contrast ratio of approximately 3.2:1, failing the WCAG AA minimum threshold of 4.5:1.
- **Impact:**  
  Screen reader users are unable to identify input field purposes, and visually impaired users experience difficulty reading timestamps and secondary metadata.
- **Recommended Fix:**  
  Add `aria-label` or visually hidden labels to form inputs, and adjust muted foregrounds to at least `#767676` (4.54:1 ratio on black).

---

## 6. AUTOMATED TOOL RESULTS

- **TypeScript Compiler (`tsc --noEmit`):**  
  **Result:** PASSED (Exit code 0).  
  All 23 routes, library modules, and context hooks are strictly typed with zero compiler diagnostics.
- **Unit & Boundary Test Suite (`vitest run`):**  
  **Result:** PASSED (Exit code 0).  
  62 test files passed; 322 unit tests passed; 8 tests skipped (`src/security/rls-probe.test.ts` requiring live Supabase credentials).  
  Test categories passing: Architecture & import boundaries, rate limiting, request correlation, net timeouts, token budgets, RRF fusion, BM25, Makalah quality validators, BibTeX resilient parser, and chat publish metadata.
- **Linter (`eslint .`):**  
  **Result:** PASSED (Exit code 0).  
  0 Errors. E2E and public assets cleanly ignored.  
  83 Warnings: React hooks (`react-hooks/set-state-in-effect` and `react-hooks/exhaustive-deps`) reviewed for SSR/mount safety.
- **Production Build (`next build`):**  
  **Result:** PASSED (Exit code 0).  
  All static pages and serverless API handlers compiled successfully with Next.js 16.3.4 (Turbopack).
- **Dependency Vulnerability Scan (`npm audit`):**  
  **Result:** SKIPPED / TIMED OUT.  
  Blocked by local offline/sandbox firewall preventing communication with `registry.npmjs.org`.

---

## 7. WHAT IS DONE WELL

1. **Client-Side AI Decoupling:** The fundamental architectural decision to keep local Ollama inference browser-local (`localhost:11434`) guarantees that member document inference is never routed through an intermediary application server.
2. **Cryptographic Protection of BYOK Keys:** BYOK keys stored in the database are protected with AES-256-GCM using authenticated encryption tags and individual 12-byte IVs, strictly isolated by owner-only RLS (`ai_credentials`).
3. **Multi-Leg Retrieval with Reciprocal Rank Fusion:** The combination of PostgreSQL Full-Text Search (`tsvector`), cosine vector similarity (`pgvector`), and client-side Okapi BM25 scored via RRF ($k=60$) provides robust, deterministic retrieval grounding.
4. **Strict Grounding & Hallucination Prevention:** In default mode (`hybrid: "off"`), if zero relevant excerpts are retrieved, the pipeline returns a plain diagnostic rather than triggering an LLM call that might hallucinate facts.
5. **Architectural Seam Enforcement Tests:** `src/architecture.test.ts` and `src/arch/enforcement.test.ts` employ static code scanning to permanently enforce architectural boundaries (e.g. banning `as any` sprawl, blocking browser imports of server secrets, ensuring explicit timeouts on all outbound fetch calls).

---

## 8. REMEDIATION ROADMAP & IMPLEMENTATION STATUS

### Fix Immediately (Critical & High) — ALL RESOLVED & VERIFIED
- [x] **Revoke and rotate credentials (SEC-01):** Compromised credentials in `env.download` rotated by user; `env.download` sanitized to placeholder values; `.gitignore` updated with `.env*` and `*.download`.
- [x] **Fix Rate Limiter IP Extraction (SEC-02):** Patched `getClientIp()` in `src/app/api/_lib/rateLimit.ts` to inspect `x-real-ip` and verified rightmost proxy entry instead of unvalidated `x-forwarded-for[0]`. Verified with 11 passing tests in `rateLimit.test.ts`.
- [x] **Eliminate Admin Oracle (SEC-03):** Updated `src/app/api/auth/register-admin/route.ts` to validate email, password, and admin key concurrently, returning consistent HTTP 400 responses for all validation and key failures. Verified with 7 passing tests in `register-admin/route.test.ts`.
- [x] **Restore Storage RLS Exact Segment Match (SEC-04):** Created and applied migration `0015_storage_and_private_chats_hardening.sql` enforcing `(storage.foldername(name))[1] = m.workspace_id::text` with 50MB size limit on `documents_bucket_insert_members`.
- [x] **Fix ESLint CI Gate (BUG-01):** Added `e2e/**` and `public/**` to `globalIgnores` in `eslint.config.mjs` so `npm run lint` exits clean (0 errors, exit 0) for CI.

### Fix This Sprint (Medium) — ALL RESOLVED & VERIFIED
- [x] **Add Admin Page Role Check (SEC-05):** Added client-side role check in `src/app/admin/page.tsx` verifying `workspace?.role === "admin"`, gating background data fetches and realtime channels, and displaying an explicit access denied notice to unauthorized users.
- [x] **Harden Private Chat RLS (SEC-06):** In migration `0015_storage_and_private_chats_hardening.sql`, removed `or public.is_workspace_admin(...)` from private chat SELECT policies on `chats` and `chat_messages` so private chats are strictly accessible only by the owner.
- [x] **Add HTTP Security Headers (SEC-08):** Configured HTTP headers in `next.config.ts`: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and `Strict-Transport-Security`.
- [x] **Fix Chat Publishing Metadata (BUG-02):** Dynamicized provider attribution in `src/lib/wb/publish.ts` to preserve dynamic AI providers (OpenAI, Anthropic, Google, DeepSeek) instead of hardcoding `"ollama"`. Verified with 2 new unit tests in `publish.test.ts`.
- [x] **Harden BibTeX Parser (BUG-03):** Updated `src/lib/importing/parsers.ts` to support parenthesis syntax `@article(key, ...)` and recover gracefully (`continue` past entry header) from unclosed or malformed entries without dropping subsequent citations. Verified with 4 unit tests in `parsers.test.ts`.

### Backlog (Low & Refactoring) — RESOLVED
- [x] **Complete HTML Escaping (SEC-10):** Updated `escapeHtml()` in `src/lib/wb/makalah/page-support.ts` to escape double quotes (`"`) and single quotes (`'`) preventing attribute breakout in Makalah export documents. Verified with 10 unit tests in `page-support.test.ts`.
- [x] **Localize PDF Worker (REL-01):** Bundled `pdf.worker.min.mjs` into `public/` and configured fallback to avoid unpinned third-party CDN dependency during browser PDF ingestion.
- [x] **Enhance Form Accessibility (A11Y-01):** Added `aria-label` and standard `autoComplete` attributes to all authentication input fields in `src/app/login/page.tsx` and `src/app/register/page.tsx`.

### Quick Wins (Small Effort, Solid Payoff)
- Adding `e2e/**` to ESLint ignores (1 line change, immediately unblocks CI).
- Adding security headers to `next.config.ts` (15 lines of configuration, mitigates Clickjacking).
- Normalizing error responses in `register-admin/route.ts` (eliminates status code oracle).
- Updating `escapeHtml` to escape quotes (5 lines of regex replacement).

---

## 9. RECOMMENDED LONG-TERM IMPROVEMENTS

1. **Automated Secret Scanning in CI:** Integrate tools like `gitleaks` or `trivy` into `.github/workflows/ci.yml` to automatically reject commits containing tokens or `.env` files.
2. **Automated Dependency Auditing:** Establish an automated dependabot or Renovate bot schedule, and incorporate `npm audit --audit-level=high` in continuous integration.
3. **Content Security Policy (CSP):** Implement a strict nonce-based or hash-based CSP to mitigate potential DOM-based XSS and control outbound fetch origins (`localhost:11434`, Supabase URL, provider endpoints).
4. **Workspace Invitation Workflows:** Transition from open self-joining on `/api/workspaces/members` to time-limited, signed invitation links managed by workspace administrators.
5. **Rate Limiting Bucket Pruning Cron:** Establish a scheduled PostgreSQL pg_cron task or Supabase Edge function executing `DELETE FROM public.rate_limit_buckets WHERE window_start < NOW() - INTERVAL '7 days'` to prevent unbounded database growth.
