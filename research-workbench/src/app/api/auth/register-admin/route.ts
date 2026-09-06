import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";

// POST /api/auth/register-admin {email, password, admin_key}
// On ADMIN_REGISTRATION_KEY match: create Supabase user → workspace → admin membership.
export async function POST(req: Request) {
  const expected = process.env.ADMIN_REGISTRATION_KEY;
  if (!expected) {
    return NextResponse.json({ error: "Admin registration is not configured" }, { status: 500 });
  }
  let body: { email?: string; password?: string; admin_key?: string; workspaceName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.admin_key !== expected) {
    return NextResponse.json({ error: "Invalid admin key" }, { status: 403 });
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }
  const supabase = createServiceSupabase();

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: createErr?.message ?? "User creation failed" }, { status: 400 });
  }
  const userId = created.user.id;

  const { data: workspace, error: wsErr } = await supabase
    .from("workspaces")
    .insert({
      name: body.workspaceName ?? process.env.DEFAULT_WORKSPACE_NAME ?? "Research Workbench",
      admin_id: userId,
    })
    .select("id")
    .single();
  if (wsErr || !workspace) {
    return NextResponse.json({ error: wsErr?.message ?? "Workspace creation failed" }, { status: 500 });
  }

  const { error: memberErr } = await supabase.from("workspace_members").insert({
    workspace_id: workspace.id,
    user_id: userId,
    role: "admin",
    status: "active",
  });
  if (memberErr) {
    return NextResponse.json({ error: memberErr.message }, { status: 500 });
  }
  await supabase.from("profiles").upsert({ id: userId });
  return NextResponse.json({ ok: true, workspaceId: workspace.id, userId });
}
