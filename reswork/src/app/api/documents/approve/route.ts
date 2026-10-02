import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireWorkspaceAdmin } from "@/app/api/_lib/auth";

// POST /api/documents/approve {documentId, decision: 'approved'|'rejected'}
// Admin-only. Member uploads land in `pending`; approval admits them to the
// shared library (visible/usable by everyone in the workspace).
// Defense in depth: explicit server-side admin check first; RLS
// (documents_update, admin-only status flip) remains the backstop.
export async function POST(req: Request) {
  let body: { documentId?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.documentId || (body.decision !== "approved" && body.decision !== "rejected")) {
    return NextResponse.json({ error: "documentId + decision (approved|rejected) required" }, { status: 400 });
  }
  const supabase = await createServerSupabase();
  const auth = await requireAuthenticatedUser(supabase);
  if ("error" in auth) return auth.error;
  // Resolve the owning workspace through the RLS-aware client (fails closed:
  // a document invisible to the caller yields not-found, not a bypass).
  const { data: doc } = await supabase
    .from("documents")
    .select("id, workspace_id")
    .eq("id", body.documentId)
    .maybeSingle();
  const workspaceId = (doc as { workspace_id: string } | null)?.workspace_id;
  if (!doc || !workspaceId) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  const admin = await requireWorkspaceAdmin(supabase, workspaceId, auth.userId);
  if ("error" in admin) return admin.error;
  const { error } = await supabase
    .from("documents")
    .update({ status: body.decision })
    .eq("id", body.documentId);
  if (error) {
    console.error("documents/approve update failed:", error.message);
    return NextResponse.json({ error: "Could not update document status" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, status: body.decision });
}
