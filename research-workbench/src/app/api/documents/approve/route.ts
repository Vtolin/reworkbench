import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

// POST /api/documents/approve {documentId, decision: 'approved'|'rejected'}
// Admin-only. Member uploads land in `pending`; approval admits them to the
// shared library (visible/usable by everyone in the workspace).
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
  const { error } = await supabase
    .from("documents")
    .update({ status: body.decision })
    .eq("id", body.documentId);
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ ok: true, status: body.decision });
}
