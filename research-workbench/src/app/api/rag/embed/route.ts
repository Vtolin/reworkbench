import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { decryptApiKey } from "@/lib/ai/keys";

// POST /api/rag/embed {text, mode: 'server', model?, apiKey?}
// Server-side embedding (cloud mode). Uses the member's own key — stored
// encrypted or forwarded per-request — never a shared workspace key.
export async function POST(req: Request) {
  // Authenticated-only even when the caller forwards their own key:
  // anonymous use would turn this into an open relay on server egress.
  const gate = await createServerSupabase();
  const { data: gateUser } = await gate.auth.getUser();
  if (!gateUser.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { text?: string; model?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  let apiKey = body.apiKey;
  if (!apiKey) {
    const supabase = await createServerSupabase();
    const { data: me } = await supabase.auth.getUser();
    if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const service = createServiceSupabase();
    const { data: cred } = await service
      .from("ai_credentials")
      .select("ciphertext, iv")
      .eq("user_id", me.user.id)
      .maybeSingle();
    if (!cred) return NextResponse.json({ error: "No cloud API key saved" }, { status: 400 });
    apiKey = decryptApiKey(cred.ciphertext, cred.iv);
  }

  const upstream = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: body.model ?? "text-embedding-3-small", input: body.text }),
  });
  if (!upstream.ok) return NextResponse.json({ error: `Embedding failed: ${upstream.status}` }, { status: 502 });
  const data = await upstream.json();
  return NextResponse.json({ embedding: data.data?.[0]?.embedding, model: body.model ?? "text-embedding-3-small" });
}
