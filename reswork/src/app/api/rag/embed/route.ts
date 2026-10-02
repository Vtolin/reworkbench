import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { decryptApiKey } from "@/lib/ai/keys";
import { selectEmbeddingCredential, type StoredCredential } from "@/lib/ai/credential-select";
import { fetchWithTimeout } from "@/lib/async/net";
import { errorCategory, logEvent } from "@/lib/observability/log";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { getRequestId, withRequestId } from "@/app/api/_lib/request";

// Same policy as the chat proxy (see ai/proxy/route.ts): explicit deadline,
// no retry — embedding calls are billed, so failures surface for an explicit
// user retry instead of silently doubling cost. 60s: embeddings are short,
// single-shot calls, unlike long generations.
const UPSTREAM_TIMEOUT_MS = 60_000;

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
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  const gate = await createServerSupabase();
  const { data: gateUser } = await gate.auth.getUser();
  if (!gateUser.user) return withRequestId(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), requestId);
  // Per-user billed-call budget (Phase 3); 429 + Retry-After when exhausted.
  const limited = await enforceRateLimit(req, "rag-embed", { userId: gateUser.user.id, requestId });
  if (limited) return withRequestId(limited, requestId);
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
    const creds = (rows ?? []) as StoredCredential[];
    if (!creds.length) return NextResponse.json({ error: "No cloud API key saved" }, { status: 400 });
    // Backend choice mirrors selectEmbeddingCredential (unit-tested):
    // explicit provider wins, else lone key, else OpenAI, else Google.
    const pick = selectEmbeddingCredential(creds, provider);
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

  const started = Date.now();
  const observe = (ok: boolean, extra: Record<string, unknown> = {}): void => {
    // Provider + model + outcome only. Never text, keys, or vectors.
    logEvent(ok ? "info" : "error", "rag.embed", {
      requestId,
      provider,
      model: body.model ?? null,
      textChars: body.text?.length ?? 0,
      durationMs: Date.now() - started,
      ok,
      ...extra,
    });
  };
  try {
    if (provider === "openai") {
      const model = body.model ?? "text-embedding-3-small";
      const upstream = await fetchWithTimeout("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: body.text,
          // text-embedding-3-* supports Matryoshka truncation: request 768d
          // so cloud vectors match the vector(768) library column exactly.
          ...(model.startsWith("text-embedding-3-") ? { dimensions: 768 } : {}),
        }),
      }, UPSTREAM_TIMEOUT_MS);
      if (!upstream.ok) {
        observe(false, { errorCategory: errorCategory(`upstream ${upstream.status}`), status: upstream.status });
        return NextResponse.json({ error: `Embedding failed (openai/${model}): ${upstream.status}` }, { status: 502 });
      }
      const data = await upstream.json();
      const embedding = data.data?.[0]?.embedding as unknown;
      if (!Array.isArray(embedding) || !embedding.length) {
        observe(false, { errorCategory: "internal" });
        return NextResponse.json({ error: "Embedding returned no vector" }, { status: 502 });
      }
      observe(true, { dims: embedding.length });
      return NextResponse.json({ embedding, model, dims: embedding.length });
    }
    if (provider === "google") {
      const model = body.model ?? "gemini-embedding-001";
      const upstream = await fetchWithTimeout(
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
        UPSTREAM_TIMEOUT_MS,
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        observe(false, { errorCategory: errorCategory(`upstream ${upstream.status}`), status: upstream.status });
        return NextResponse.json({ error: `Embedding failed (google/${model}): ${upstream.status} — ${text.slice(0, 200)}` }, { status: 502 });
      }
      const data = await upstream.json();
      const embedding = (data.embedding as { values?: unknown } | undefined)?.values as unknown;
      if (!Array.isArray(embedding) || !embedding.length) {
        observe(false, { errorCategory: "internal" });
        return NextResponse.json({ error: "Embedding returned no vector" }, { status: 502 });
      }
      observe(true, { dims: embedding.length });
      return NextResponse.json({ embedding, model, dims: embedding.length });
    }
    return NextResponse.json(
      { error: `Provider "${provider}" has no embedding API. Save an OpenAI or Google key in Settings, or use Embedding mode Local.` },
      { status: 400 },
    );
  } catch (e) {
    observe(false, { errorCategory: errorCategory(e) });
    return NextResponse.json({ error: "Embedding failed" }, { status: 500 });
  }
}
