import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin } from "@/app/api/_lib/auth";
import { clampMemberLimit, MAX_ALLOWED_MEMBERS } from "@/lib/permissions/constants";

// PATCH /api/workspaces/limit {workspaceId, member_limit}
// Admin-only (explicit server-side role check + RLS backstop).
// Bounded server-side by MAX_ALLOWED_MEMBERS.
export async function PATCH(req: Request) {
  let body: { workspaceId?: string; member_limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const clamped = clampMemberLimit(body.member_limit);
  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  const admin = await requireWorkspaceAdmin(supabase, body.workspaceId, auth.userId);
  if ("error" in admin) return admin.error;
  const { error } = await supabase
    .from("workspaces")
    .update({ member_limit: clamped })
    .eq("id", body.workspaceId);
  if (error) {
    console.error("workspaces/limit update failed:", error.message);
    return NextResponse.json({ error: "Could not update member limit" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, member_limit: clamped, maxAllowed: MAX_ALLOWED_MEMBERS });
}
