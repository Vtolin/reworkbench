import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

// POST /api/chats/import {sourceChatId, title?}
// "Import to my chats": copies a workspace-visible chat into a brand-new,
// independent chat owned by the caller. Records the link in chat_imports.
// Imported chats are fully separate threads — no shared editing.
export async function POST(req: Request) {
  let body: { sourceChatId?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.sourceChatId) return NextResponse.json({ error: "sourceChatId required" }, { status: 400 });
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: source, error: srcErr } = await supabase
    .from("chats")
    .select("id, workspace_id, title")
    .eq("id", body.sourceChatId)
    .single();
  if (srcErr || !source) return NextResponse.json({ error: "Source chat not visible" }, { status: 404 });

  const { data: target, error: tgtErr } = await supabase
    .from("chats")
    .insert({
      workspace_id: source.workspace_id,
      owner_id: me.user.id,
      title: body.title ?? `Imported: ${source.title}`,
      visibility: "workspace",
    })
    .select("id")
    .single();
  if (tgtErr || !target) {
    return NextResponse.json({ error: tgtErr?.message ?? "Import failed" }, { status: 500 });
  }

  const { data: messages } = await supabase
    .from("chat_messages")
    .select("role, content, metadata_json")
    .eq("chat_id", body.sourceChatId)
    .order("created_at");
  if (messages && messages.length > 0) {
    await supabase.from("chat_messages").insert(
      messages.map((m) => ({
        chat_id: target.id,
        role: m.role,
        content: m.content,
        metadata_json: m.metadata_json ?? {},
      })),
    );
  }
  await supabase.from("chat_imports").insert({
    source_chat_id: body.sourceChatId,
    target_chat_id: target.id,
    imported_by: me.user.id,
  });
  return NextResponse.json({ ok: true, targetChatId: target.id });
}
