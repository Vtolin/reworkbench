import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin, requireWorkspaceMember } from "@/app/api/_lib/auth";

// GET /api/workspaces/auto-approve?workspaceId=...
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  const member = await requireWorkspaceMember(supabase, workspaceId, auth.userId);
  if ("error" in member) return member.error;

  const { data, error } = await supabase
    .from("workspaces")
    .select("auto_approve_uploads")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ auto_approve_uploads: false });
  }

  return NextResponse.json({
    auto_approve_uploads: Boolean((data as { auto_approve_uploads?: boolean } | null)?.auto_approve_uploads),
  });
}

// PATCH /api/workspaces/auto-approve { workspaceId, auto_approve_uploads }
export async function PATCH(req: Request) {
  let body: { workspaceId?: string; auto_approve_uploads?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  if (typeof body.auto_approve_uploads !== "boolean") {
    return NextResponse.json({ error: "auto_approve_uploads boolean required" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  const admin = await requireWorkspaceAdmin(supabase, body.workspaceId, auth.userId);
  if ("error" in admin) return admin.error;

  const { error } = await supabase
    .from("workspaces")
    .update({ auto_approve_uploads: body.auto_approve_uploads })
    .eq("id", body.workspaceId);

  if (error) {
    console.error("workspaces/auto-approve update failed:", error.message);
    return NextResponse.json({ error: "Could not update auto-approve setting" }, { status: 403 });
  }

  return NextResponse.json({ ok: true, auto_approve_uploads: body.auto_approve_uploads });
}
