import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { OPENAI_COMPAT_BASE, KNOWN_PROVIDERS, resolveApiKey } from "@/lib/ai/providers";

// POST /api/ai/proxy {provider, model, messages, temperature, apiKey?}
// Cloud-AI proxy (BYOK): resolves the caller's OWN stored key server-side
// (ai_credentials, owner-only RLS + AES-GCM at rest) and forwards to the
// cloud provider. Never uses a shared workspace key. Never logs keys.
export async function POST(req: Request) {
  let body: {
    provider?: string;
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    apiKey?: string; // optional client-held key (client-side-only mode)
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.provider || !body.model || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: "provider, model, messages are required" }, { status: 400 });
  }
  if (!KNOWN_PROVIDERS.includes(body.provider)) {
    return NextResponse.json({ error: `Unsupported provider: ${body.provider}` }, { status: 400 });
  }

  const { key: apiKey, error, status } = await resolveApiKey(body.apiKey);
  if (!apiKey) return NextResponse.json({ error }, { status: status ?? 500 });

  try {
    const compatBase = OPENAI_COMPAT_BASE[body.provider];
    if (compatBase) {
      const upstream = await fetch(`${compatBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          temperature: body.temperature ?? 0,
        }),
      });
      if (!upstream.ok) return NextResponse.json({ error: `${body.provider} error: ${upstream.status}` }, { status: 502 });
      const data = await upstream.json();
      return NextResponse.json({ content: data.choices?.[0]?.message?.content ?? "" });
    }
    // Anthropic native API.
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: 2048,
        messages: body.messages.filter((m) => m.role !== "system"),
        system: body.messages.find((m) => m.role === "system")?.content,
        temperature: body.temperature ?? 0,
      }),
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: `Anthropic error: ${upstream.status}` }, { status: 502 });
    }
    const data = await upstream.json();
    const text = (data.content ?? []).map((b: { text?: string }) => b.text ?? "").join("");
    return NextResponse.json({ content: text });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Proxy failed" }, { status: 500 });
  }
}

// PUT /api/ai/proxy {provider, apiKey} — save personal BYOK key (encrypted).
export async function PUT(req: Request) {
  let body: { provider?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.provider || !body.apiKey) {
    return NextResponse.json({ error: "provider and apiKey are required" }, { status: 400 });
  }
  if (!KNOWN_PROVIDERS.includes(body.provider)) {
    return NextResponse.json({ error: `Unsupported provider: ${body.provider}` }, { status: 400 });
  }
  const { encryptApiKey } = await import("@/lib/ai/keys");
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ciphertext, iv } = encryptApiKey(body.apiKey);
  const { error } = await supabase.from("ai_credentials").upsert({
    user_id: me.user.id,
    provider: body.provider,
    ciphertext,
    iv,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/ai/proxy — forget the caller's stored BYOK key (owner-only).
// Idempotent: succeeds even if no key was saved. Note this only makes the
// app forget the key; to truly revoke it, rotate/delete it in the
// provider's own dashboard (OpenAI/DeepSeek/…).
export async function DELETE() {
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { error } = await supabase.from("ai_credentials").delete().eq("user_id", me.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
