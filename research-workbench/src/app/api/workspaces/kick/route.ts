import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";

// POST /api/workspaces/kick {workspaceId, userId}
// Admin-only. Soft-remove: sets status='removed' (preserves audit trail,
// does NOT hard-delete the Supabase account) and invalidates sessions.
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
  const supabase = await createServerSupabase();
  // Verify caller is admin (RLS double-checks on the update below).
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: caller } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", body.workspaceId)
    .eq("user_id", me.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (caller?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const service = createServiceSupabase();
  const { error } = await service
    .from("workspace_members")
    .update({ status: "removed" })
    .eq("workspace_id", body.workspaceId)
    .eq("user_id", body.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Invalidate all sessions for the kicked member.
  await service.auth.admin.signOut(body.userId);
  return NextResponse.json({ ok: true });
}
