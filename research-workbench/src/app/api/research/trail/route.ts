import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

// POST /api/research/trail {workspaceId, projectId?, event_type, payload}
// Shared research-trail events (visibility only — authorship stays per-member).
export async function POST(req: Request) {
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
  const { data: me } = await supabase.auth.getUser();
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
    created_by: me.user?.id ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ ok: true });
}

// GET /api/research/trail?workspaceId=&limit= — workspace-shared trail.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspaceId");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("research_trail")
    .select("id, event_type, payload_json, created_by, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ trail: data });
}
