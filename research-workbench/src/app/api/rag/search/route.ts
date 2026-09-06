import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

// POST /api/rag/search {workspaceId, query, queryEmbedding?, topN?}
// Runs the FTS leg + pgvector leg (RLS-gated RPCs that only return approved
// docs in the caller's workspace). Browser fuses with RRF.
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
  const topN = Math.min(Math.max(body.topN ?? 20, 1), 50);
  const supabase = await createServerSupabase();

  const { data: fts, error: ftsErr } = await supabase.rpc("fts_search_chunks", {
    ws_id: body.workspaceId,
    q: body.query,
    match_count: topN,
  });
  if (ftsErr) {
    // Don't echo raw Postgres errors (they can include the crafted query).
    console.error("fts_search_chunks failed:", ftsErr.message);
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
  return NextResponse.json({ fts: fts ?? [], vector });
}
