import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/app/api/_lib/auth";
import { errorCategory, logEvent } from "@/lib/observability/log";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { parseBoundedInt } from "@/app/api/_lib/numbers";
import { getRequestId, withRequestId } from "@/app/api/_lib/request";

// POST /api/rag/search {workspaceId, query, queryEmbedding?, topN?}
// Runs the FTS leg + pgvector leg (RLS-gated RPCs that only return approved
// docs in the caller's workspace). Browser fuses with RRF.
// Authenticated workspace members only: the workspaceId comes from the
// request body and must not be trusted on its own (explicit membership
// check + RLS-gated RPCs as backstop).
export async function POST(req: Request) {
  let body: { workspaceId?: string; query?: string; queryEmbedding?: number[] | null; topN?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.query) {
    return NextResponse.json({ error: "workspaceId and query are required" }, { status: 400 });
  }
  // Finite-parse (Phase 8): ?topN=abc used to flow NaN into match_count
  // (RPC error → 500). Invalid is a 400 now.
  const parsedTopN = parseBoundedInt(body.topN, {
    min: 1,
    max: 50,
    name: "topN",
    missing: 20,
    onInvalid: "error",
  });
  if ("error" in parsedTopN) {
    return NextResponse.json({ error: parsedTopN.error }, { status: 400 });
  }
  const topN = parsedTopN.value ?? 20;
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  // Per-user search budget (Phase 3), checked before the membership lookup
  // so over-budget callers skip straight to 429 + Retry-After.
  const limited = await enforceRateLimit(req, "rag-search", { userId: auth.userId, requestId });
  if (limited) return withRequestId(limited, requestId);
  const member = await requireWorkspaceMember(supabase, body.workspaceId, auth.userId);
  if ("error" in member) return member.error;

  const started = Date.now();
  const { data: fts, error: ftsErr } = await supabase.rpc("fts_search_chunks", {
    ws_id: body.workspaceId,
    q: body.query,
    match_count: topN,
  });
  if (ftsErr) {
    // Don't echo raw Postgres errors (they can include the crafted query).
    console.error("fts_search_chunks failed:", ftsErr.message);
    logEvent("error", "rag.search", {
      requestId,
      workspaceId: body.workspaceId,
      topN,
      hasEmbedding: !!(body.queryEmbedding && body.queryEmbedding.length > 0),
      durationMs: Date.now() - started,
      ok: false,
      errorCategory: errorCategory(ftsErr.message),
    });
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }

  let vector: unknown[] = [];
  if (body.queryEmbedding && body.queryEmbedding.length > 0) {
    const { data, error } = await supabase.rpc("vector_search_chunks", {
      ws_id: body.workspaceId,
      query_embedding: body.queryEmbedding,
      match_count: topN,
    });
    if (error) {
      // Vector leg is optional (e.g. dimension mismatch after model change).
      vector = [];
    } else {
      vector = data ?? [];
    }
  }
  // Query text is user content: log counts, never the query itself.
  logEvent("info", "rag.search", {
    requestId,
    workspaceId: body.workspaceId,
    topN,
    hasEmbedding: !!(body.queryEmbedding && body.queryEmbedding.length > 0),
    ftsCount: (fts ?? []).length,
    vectorCount: vector.length,
    durationMs: Date.now() - started,
    ok: true,
  });
  return NextResponse.json({ fts: fts ?? [], vector });
}
