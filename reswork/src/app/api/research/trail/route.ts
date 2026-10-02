import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/app/api/_lib/auth";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { parseBoundedInt } from "@/app/api/_lib/numbers";
import { getRequestId, logRequest, withRequestId } from "@/app/api/_lib/request";
import { TRAIL_PAYLOAD_MAX_BYTES, isOverLimit, tooLargeResponse } from "@/app/api/_lib/sizeLimits";

// POST /api/research/trail {workspaceId, projectId?, event_type, payload}
// Shared research-trail events (visibility only — authorship stays per-member).
// Authenticated workspace members only; authorship is the verified caller,
// never a client-provided id.
export async function POST(req: Request) {
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  const started = Date.now();
  let body: { workspaceId?: string; projectId?: string | null; event_type?: string; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.event_type) {
    return NextResponse.json({ error: "workspaceId and event_type required" }, { status: 400 });
  }
  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  // Per-user write budget (Phase 3); 429 + Retry-After when exhausted.
  const limited = await enforceRateLimit(req, "research-trail", { userId: auth.userId, requestId });
  if (limited) return withRequestId(limited, requestId);
  // 32KB server-side cap on the stored JSON (413, never a truncated write).
  if (isOverLimit(body.payload ?? {}, TRAIL_PAYLOAD_MAX_BYTES)) {
    return tooLargeResponse("payload", TRAIL_PAYLOAD_MAX_BYTES);
  }
  const member = await requireWorkspaceMember(supabase, body.workspaceId, auth.userId);
  if ("error" in member) return member.error;
  // A modified client could otherwise file trail events under another
  // workspace's project id. Verify the project belongs to this workspace.
  if (body.projectId) {
    const { data: proj } = await supabase
      .from("research_projects")
      .select("id")
      .eq("id", body.projectId)
      .eq("workspace_id", body.workspaceId)
      .maybeSingle();
    if (!proj) return NextResponse.json({ error: "Project not found in this workspace" }, { status: 403 });
  }
  const { error } = await supabase.from("research_trail").insert({
    workspace_id: body.workspaceId,
    project_id: body.projectId ?? null,
    event_type: body.event_type,
    payload_json: (body.payload ?? {}) as never,
    created_by: auth.userId,
  });
  if (error) {
    console.error("research/trail insert failed:", error.message);
    logRequest(requestId, "research.trail", started, false, {});
    return withRequestId(NextResponse.json({ error: "Could not record trail event" }, { status: 403 }), requestId);
  }
  logRequest(requestId, "research.trail", started, true, {});
  return withRequestId(NextResponse.json({ ok: true }), requestId);
}

// Numeric query-param policy: finite-parse, default, clamp. A present but
// non-numeric limit (?limit=abc) is a client error (400), never silently
// coerced to NaN/Unbounded and never masked as a 403 membership failure.
export const TRAIL_LIMIT_DEFAULT = 50;
export const TRAIL_LIMIT_MIN = 1;
export const TRAIL_LIMIT_MAX = 200;

export function parseTrailLimit(
  raw: string | null,
): { limit: number } | { error: string } {
  // Single implementation lives in _lib/numbers (Phase 8): identical
  // contract (default 50, clamp 1..200, 400 on non-numeric).
  const out = parseBoundedInt(raw, {
    min: TRAIL_LIMIT_MIN,
    max: TRAIL_LIMIT_MAX,
    name: "limit",
    missing: TRAIL_LIMIT_DEFAULT,
    onInvalid: "error",
  });
  if ("error" in out) return { error: out.error };
  return { limit: out.value ?? TRAIL_LIMIT_DEFAULT };
}

// GET /api/research/trail?workspaceId=&limit= — workspace-shared trail.
// Authenticated workspace members only; row visibility still comes from RLS.
export async function GET(req: Request) {
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  const started = Date.now();
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  const parsedLimit = parseTrailLimit(searchParams.get("limit"));
  if ("error" in parsedLimit) {
    return NextResponse.json({ error: parsedLimit.error }, { status: 400 });
  }
  const limit = parsedLimit.limit;
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  // Shared per-user budget with POST (Phase 3); 429 + Retry-After when exhausted.
  const limited = await enforceRateLimit(req, "research-trail", { userId: auth.userId, requestId });
  if (limited) return withRequestId(limited, requestId);
  const member = await requireWorkspaceMember(supabase, workspaceId, auth.userId);
  if ("error" in member) return member.error;
  const { data, error } = await supabase
    .from("research_trail")
    .select("id, event_type, payload_json, created_by, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("research/trail read failed:", error.message);
    logRequest(requestId, "research.trail", started, false, {});
    return withRequestId(NextResponse.json({ error: "Could not load trail" }, { status: 403 }), requestId);
  }
  logRequest(requestId, "research.trail", started, true, {});
  return withRequestId(NextResponse.json({ trail: data }), requestId);
}
