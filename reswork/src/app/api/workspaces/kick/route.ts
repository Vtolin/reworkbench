import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin } from "@/app/api/_lib/auth";

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
  // Verify caller is admin via the shared guard (RLS double-checks below).
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  const admin = await requireWorkspaceAdmin(supabase, body.workspaceId, auth.userId);
  if ("error" in admin) return admin.error;
  if (body.userId === auth.userId) {
    return NextResponse.json({ error: "You cannot kick yourself" }, { status: 400 });
  }
  const service = createServiceSupabase();
  // Refuse to remove the last active admin (would orphan the workspace).
  const { data: admins, error: adminErr } = await service
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", body.workspaceId)
    .eq("status", "active")
    .eq("role", "admin");
  if (adminErr) {
    console.error("workspaces/kick admin lookup failed:", adminErr.message);
    return NextResponse.json({ error: "Could not verify workspace admins" }, { status: 500 });
  }
  const targetIsAdmin = ((admins ?? []) as Array<{ user_id: string }>).some((a) => a.user_id === body.userId);
  if (targetIsAdmin && (admins ?? []).length <= 1) {
    return NextResponse.json({ error: "Cannot remove the last admin" }, { status: 400 });
  }
  const { data: target, error: targetErr } = await service
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", body.workspaceId)
    .eq("user_id", body.userId)
    .eq("status", "active")
    .maybeSingle();
  if (targetErr) {
    console.error("workspaces/kick member lookup failed:", targetErr.message);
    return NextResponse.json({ error: "Could not verify workspace member" }, { status: 500 });
  }
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const { error } = await service
    .from("workspace_members")
    .update({ status: "removed" })
    .eq("workspace_id", body.workspaceId)
    .eq("user_id", body.userId);
  if (error) {
    console.error("workspaces/kick removal failed:", error.message);
    return NextResponse.json({ error: "Could not remove member" }, { status: 500 });
  }
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
