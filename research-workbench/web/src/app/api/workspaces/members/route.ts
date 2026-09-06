import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { MAX_ALLOWED_MEMBERS, clampMemberLimit } from "@/lib/permissions/constants";

// GET /api/workspaces/members?workspaceId= — list active members (member-gated).
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("id, user_id, role, status, joined_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("joined_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ members: data, maxAllowed: MAX_ALLOWED_MEMBERS });
}

// POST /api/workspaces/members {workspaceId} — self-join guard: enforces
// current_members < member_limit (soft) AND absolute MAX_ALLOWED_MEMBERS.
// Uses service role with a server-side re-check so a modified client cannot
// bypass the limit. Called after Supabase Auth signUp.
export async function POST(req: Request) {
  let body: { workspaceId?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.userId) {
    return NextResponse.json({ error: "workspaceId and userId are required" }, { status: 400 });
  }
  const service = createServiceSupabase();
  const { data: ws } = await service
    .from("workspaces")
    .select("id, member_limit")
    .eq("id", body.workspaceId)
    .single();
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const softLimit = clampMemberLimit(ws.member_limit);
  const { count } = await service
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", body.workspaceId)
    .eq("status", "active");
  const current = count ?? 0;
  if (current >= softLimit || current >= MAX_ALLOWED_MEMBERS) {
    return NextResponse.json(
      { error: "Registration is currently closed. Please contact the administrator." },
      { status: 403 },
    );
  }
  const { error } = await service.from("workspace_members").insert({
    workspace_id: body.workspaceId,
    user_id: body.userId,
    role: "member",
    status: "active",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await service.from("profiles").upsert({ id: body.userId });
  return NextResponse.json({ ok: true });
}
