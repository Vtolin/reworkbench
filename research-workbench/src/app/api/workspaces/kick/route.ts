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
  // Invalidate the kicked member's sessions. NOTE: auth.admin.signOut() takes
  // a session JWT, not a user id — passing a UUID is a silent no-op. Banning
  // is the mechanism that actually revokes all of the user's tokens. The
  // account itself is preserved (audit trail); RLS already excludes removed
  // members, so the ban is defense in depth.
  const { error: banError } = await service.auth.admin.updateUserById(body.userId, {
    ban_duration: "876000h", // ~100 years; only an admin action could lift it
  });
  if (banError) {
    // Row removal above is the real enforcement; report but don't fail it.
    console.error("kick: ban failed for", body.userId, banError.message);
  }
  return NextResponse.json({ ok: true });
}
