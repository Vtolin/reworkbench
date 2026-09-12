import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { decryptApiKey } from "@/lib/ai/keys";

// POST /api/rag/embed {text, mode: 'server', model?, provider?, apiKey?}
// Server-side embedding (cloud mode). Routes by provider using the member's
// own key — stored encrypted or forwarded per-request — never a shared key.
// The library stores vector(768), so every provider is asked for 768 dims
// explicitly (OpenAI `dimensions`, Google `outputDimensionality`): stored and
// query vectors stay comparable no matter which backend produced them.
// Providers without an embedding API (deepseek, anthropic) get a clear 400,
// not a silent wrong answer.
export async function POST(req: Request) {
  // Authenticated-only even when the caller forwards their own key:
  // anonymous use would turn this into an open relay on server egress.
  const gate = await createServerSupabase();
  const { data: gateUser } = await gate.auth.getUser();
  if (!gateUser.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { text?: string; model?: string; provider?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  // Resolve which backend to call: explicit provider wins, otherwise the
  // member's stored credential decides (single key = unambiguous; several
  // keys = prefer one with an embedding API, OpenAI first).
  let apiKey = body.apiKey;
  let provider = (body.provider ?? "").toLowerCase();
  if (!apiKey) {
    const supabase = await createServerSupabase();
    const { data: me } = await supabase.auth.getUser();
    if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const service = createServiceSupabase();
    const { data: rows } = await service
      .from("ai_credentials")
      .select("ciphertext, iv, provider")
      .eq("user_id", me.user.id);
    const creds = (rows ?? []) as Array<{ ciphertext: string; iv: string; provider: string }>;
    if (!creds.length) return NextResponse.json({ error: "No cloud API key saved" }, { status: 400 });
    const pick =
      (provider && creds.find((c) => c.provider === provider)) ||
      (creds.length === 1 ? creds[0] : undefined) ||
      creds.find((c) => c.provider === "openai") ||
      creds.find((c) => c.provider === "google");
    if (!pick) {
      return NextResponse.json(
        { error: "No usable embedding key: save an OpenAI or Google key in Settings, or use Embedding mode Local." },
        { status: 400 },
      );
    }
    try {
      apiKey = decryptApiKey(pick.ciphertext, pick.iv);
    } catch {
      return NextResponse.json({ error: "Stored key could not be decrypted" }, { status: 500 });
    }
    provider = pick.provider;
  }
  if (!provider) provider = "openai"; // forwarded-key callers without a provider: legacy default

  try {
    if (provider === "openai") {
      const model = body.model ?? "text-embedding-3-small";
      const upstream = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: body.text,
          // text-embedding-3-* supports Matryoshka truncation: request 768d
          // so cloud vectors match the vector(768) library column exactly.
          ...(model.startsWith("text-embedding-3-") ? { dimensions: 768 } : {}),
        }),
      });
      if (!upstream.ok) return NextResponse.json({ error: `Embedding failed (openai/${model}): ${upstream.status}` }, { status: 502 });
      const data = await upstream.json();
      const embedding = data.data?.[0]?.embedding as unknown;
      if (!Array.isArray(embedding) || !embedding.length) {
        return NextResponse.json({ error: "Embedding returned no vector" }, { status: 502 });
      }
      return NextResponse.json({ embedding, model, dims: embedding.length });
    }
    if (provider === "google") {
      const model = body.model ?? "gemini-embedding-001";
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey as string },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text: body.text }] },
            // Gemini embeddings are Matryoshka too: 768d matches vector(768).
            outputDimensionality: 768,
          }),
        },
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        return NextResponse.json({ error: `Embedding failed (google/${model}): ${upstream.status} — ${text.slice(0, 200)}` }, { status: 502 });
      }
      const data = await upstream.json();
      const embedding = (data.embedding as { values?: unknown } | undefined)?.values as unknown;
      if (!Array.isArray(embedding) || !embedding.length) {
        return NextResponse.json({ error: "Embedding returned no vector" }, { status: 502 });
      }
      return NextResponse.json({ embedding, model, dims: embedding.length });
    }
    return NextResponse.json(
      { error: `Provider "${provider}" has no embedding API. Save an OpenAI or Google key in Settings, or use Embedding mode Local.` },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Embedding failed" }, { status: 500 });
  }
}
