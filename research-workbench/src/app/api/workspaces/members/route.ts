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

// POST /api/workspaces/members {userId, workspaceId?} — self-join guard:
// enforces current_members < member_limit (soft) AND absolute
// MAX_ALLOWED_MEMBERS. The workspace is resolved server-side (service role)
// because RLS hides workspaces from non-members — a direct client lookup
// would always come back empty for a brand-new user.
// Uses service role with a server-side re-check so a modified client cannot
// bypass the limit. Called after Supabase Auth signUp.
export async function POST(req: Request) {
  let body: { workspaceId?: string; userId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  // Security: verify the caller is actually the user they claim to be.
  // Without this check, anyone with a known userId UUID could self-join.
  const callerSupabase = await createServerSupabase();
  const { data: callerData } = await callerSupabase.auth.getUser();
  if (!callerData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (callerData.user.id !== body.userId) {
    return NextResponse.json({ error: "Forbidden: userId does not match authenticated user" }, { status: 403 });
  }
  const service = createServiceSupabase();
  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    // Single-workspace MVP: join the oldest workspace.
    const { data: first } = await service
      .from("workspaces")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    workspaceId = (first as { id: string } | null)?.id;
  }
  if (!workspaceId) {
    return NextResponse.json({ error: "No workspace exists yet — ask the admin to register first." }, { status: 404 });
  }
  // Kicked members must not be able to self-rejoin (the JoinGate calls this
  // route too). Their row stays `removed`; only an admin re-admitting them
  // could change that (no such flow exists by design).
  const { data: existing } = await service
    .from("workspace_members")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("user_id", body.userId)
    .maybeSingle();
  const existingStatus = (existing as { status: string } | null)?.status;
  if (existingStatus === "removed") {
    return NextResponse.json(
      { error: "Your access was revoked by the administrator. Please contact them." },
      { status: 403 },
    );
  }
  if (existingStatus === "active") {
    // Idempotent retry (double-click / network retry) — already a member.
    return NextResponse.json({ ok: true });
  }
  const { data: ws } = await service
    .from("workspaces")
    .select("id, member_limit")
    .eq("id", workspaceId)
    .single();
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const softLimit = clampMemberLimit((ws as { member_limit: number }).member_limit);
  const { count } = await service
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  const current = count ?? 0;
  if (current >= softLimit || current >= MAX_ALLOWED_MEMBERS) {
    return NextResponse.json(
      { error: "Registration is currently closed. Please contact the administrator." },
      { status: 403 },
    );
  }
  const { error } = await service.from("workspace_members").insert({
    workspace_id: workspaceId,
    user_id: body.userId,
    role: "member",
    status: "active",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await service.from("profiles").upsert({ id: body.userId });
  return NextResponse.json({ ok: true });
}
