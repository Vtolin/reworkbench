import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { clampMemberLimit, MAX_ALLOWED_MEMBERS } from "@/lib/permissions/constants";

// PATCH /api/workspaces/limit {workspaceId, member_limit}
// Admin-only (RLS also enforces). Bounded server-side by MAX_ALLOWED_MEMBERS.
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
  const { error } = await supabase
    .from("workspaces")
    .update({ member_limit: clamped })
    .eq("id", body.workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ ok: true, member_limit: clamped, maxAllowed: MAX_ALLOWED_MEMBERS });
}
