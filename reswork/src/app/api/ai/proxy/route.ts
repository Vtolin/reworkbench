import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { OPENAI_COMPAT_BASE, KNOWN_PROVIDERS, resolveApiKey, buildGoogleExtraBody, isGemini3, upstreamError, type GeminiThinkLevel } from "@/lib/ai/providers";
import { fetchWithTimeout } from "@/lib/async/net";
import { errorCategory, logEvent } from "@/lib/observability/log";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { parseBoundedInt } from "@/app/api/_lib/numbers";
import { getRequestId, withRequestId } from "@/app/api/_lib/request";
import { PROXY_MESSAGES_MAX_BYTES, isOverLimit, tooLargeResponse } from "@/app/api/_lib/sizeLimits";

// Upstream-call policy (Task N): every provider fetch has an explicit
// deadline so a half-open socket cannot hang the function past the platform
// limit. There is deliberately NO retry here: completions are billed, and an
// automatic retry doubles cost (and can double side effects on non-idempotent
// backends). Failures surface to the user, who retries explicitly.
const UPSTREAM_TIMEOUT_MS = 120_000;

// POST /api/ai/proxy {provider, model, messages, temperature?, thinking?, maxTokens?, apiKey?, thinkingBudget?, thinkLevel?, jsonMode?}
// Cloud-AI proxy (BYOK): resolves the caller's OWN stored key server-side
// (ai_credentials, owner-only RLS + AES-GCM at rest) and forwards to the
// cloud provider. Never uses a shared workspace key. Never logs keys.
// thinking:false maps to minimal/0 on Google (never provider-default medium).
// maxTokens caps output (makalahBudget); jsonMode requests strict JSON.
// temperature is omitted for Gemini 3 (provider ignores it).
export async function POST(req: Request) {
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  // Authenticated-only: even BYOK-with-own-key callers must hold a session,
  // otherwise this is an open relay on Vercel egress/compute.
  const gate = await createServerSupabase();
  const { data: gateUser } = await gate.auth.getUser();
  if (!gateUser.user) return withRequestId(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), requestId);
  // Per-user billed-call budget (Phase 3); 429 + Retry-After when exhausted.
  // Billed calls are still never retried (see policy below).
  const limited = await enforceRateLimit(req, "ai-proxy", { userId: gateUser.user.id, requestId });
  if (limited) return withRequestId(limited, requestId);
  let body: {
    provider?: string;
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    apiKey?: string; // optional client-held key (client-side-only mode)
    thinking?: boolean;
    maxTokens?: number;
    thinkingBudget?: number;
    thinkLevel?: GeminiThinkLevel;
    jsonMode?: boolean;
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
  // 256KB server-side cap on the conversation (413, never a truncated call).
  if (isOverLimit(body.messages, PROXY_MESSAGES_MAX_BYTES)) {
    return tooLargeResponse("messages", PROXY_MESSAGES_MAX_BYTES);
  }

  const { key: apiKey, error, status } = await resolveApiKey(body.apiKey, body.provider);
  if (!apiKey) return NextResponse.json({ error }, { status: status ?? 500 });

  const started = Date.now();
  const observe = (ok: boolean, extra: Record<string, unknown> = {}): void => {
    // Provider + model + outcome only. Never messages, keys, or bodies.
    logEvent(ok ? "info" : "error", "ai.proxy", {
      requestId,
      provider: body.provider,
      model: body.model,
      durationMs: Date.now() - started,
      ok,
      ...extra,
    });
  };
  try {
    const compatBase = OPENAI_COMPAT_BASE[body.provider];
    if (compatBase) {
      const extra_body =
        body.provider === "google"
          ? buildGoogleExtraBody({
              model: body.model ?? "",
              thinking: typeof body.thinking === "boolean" ? body.thinking : undefined,
              thinkingBudget: body.thinkingBudget,
              thinkLevel: body.thinkLevel,
            })
          : undefined;
      // Finite-parse (Phase 8): invalid maxTokens falls back to omitted
      // (provider default), exactly as the inline check before it.
      const maxTokensParsed = parseBoundedInt(body.maxTokens, {
        min: 128,
        max: 16384,
        name: "maxTokens",
        missing: undefined,
        onInvalid: "fallback",
      });
      const maxTokens = "value" in maxTokensParsed ? maxTokensParsed.value : undefined;
      const omitTemperature = body.provider === "google" && isGemini3(body.model ?? "");
      const upstream = await fetchWithTimeout(`${compatBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          ...(omitTemperature ? {} : { temperature: body.temperature ?? 0 }),
          ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
          ...(body.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(extra_body ? { extra_body } : {}),
        }),
      }, UPSTREAM_TIMEOUT_MS);
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        observe(false, { errorCategory: errorCategory(`upstream ${upstream.status}`), status: upstream.status });
        return NextResponse.json({ error: upstreamError(body.provider, upstream.status, text) }, { status: 502 });
      }
      const data = await upstream.json();
      const msg = data.choices?.[0]?.message ?? {};
      const thinking =
        (typeof msg.reasoning_content === "string" && msg.reasoning_content) ||
        (typeof msg.reasoning === "string" && msg.reasoning) ||
        (typeof msg.thinking === "string" && msg.thinking) ||
        undefined;
      observe(true);
      return NextResponse.json({
        content: msg.content ?? "",
        ...(thinking ? { thinking } : {}),
      });
    }
    // Anthropic native API. Invalid maxTokens falls back to 2048, as before.
    const anthropicParsed = parseBoundedInt(body.maxTokens, {
      min: 256,
      max: 8192,
      name: "maxTokens",
      missing: 2048,
      onInvalid: "fallback",
    });
    const anthropicMax = "value" in anthropicParsed ? (anthropicParsed.value ?? 2048) : 2048;
    const upstream = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: anthropicMax,
        messages: body.messages.filter((m) => m.role !== "system"),
        system: body.messages.find((m) => m.role === "system")?.content,
        temperature: body.temperature ?? 0,
      }),
    }, UPSTREAM_TIMEOUT_MS);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      observe(false, { errorCategory: errorCategory(`upstream ${upstream.status}`), status: upstream.status });
      return NextResponse.json({ error: upstreamError("Anthropic", upstream.status, text) }, { status: 502 });
    }
    const data = await upstream.json();
    const text = (data.content ?? []).map((b: { text?: string }) => b.text ?? "").join("");
    observe(true);
    return NextResponse.json({ content: text });
  } catch (e) {
    observe(false, { errorCategory: errorCategory(e) });
    return NextResponse.json({ error: "Proxy failed" }, { status: 500 });
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
  // One row per (user_id, provider): the conflict target must name both,
  // otherwise saving a second provider overwrites the first (single-column
  // PK default). See migration 0005.
  const { error } = await supabase.from("ai_credentials").upsert(
    {
      user_id: me.user.id,
      provider: body.provider,
      ciphertext,
      iv,
    },
    { onConflict: "user_id,provider" },
  );
  if (error) {
    console.error("ai/proxy key save failed:", error.message);
    return NextResponse.json({ error: "Could not save API key" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/ai/proxy [{provider}] — forget stored BYOK key(s).
// With {provider}: removes only that provider's key (matches the Settings
// "Remove key" intent for the selected provider). Without a body: removes
// all of the caller's keys (legacy behavior for single-key users).
// Idempotent: succeeds even if no key was saved. Note this only makes the
// app forget the key; to truly revoke it, rotate/delete it in the
// provider's own dashboard (OpenAI/DeepSeek/…).
export async function DELETE(req: Request) {
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let provider: string | null = null;
  try {
    const body = (await req.json()) as { provider?: unknown };
    if (typeof body?.provider === "string" && body.provider) {
      provider = body.provider.toLowerCase();
    }
  } catch {
    // No body — legacy delete-all path below.
  }
  let query = supabase.from("ai_credentials").delete().eq("user_id", me.user.id);
  if (provider) query = query.eq("provider", provider);
  const { error } = await query;
  if (error) {
    console.error("ai/proxy key delete failed:", error.message);
    return NextResponse.json({ error: "Could not forget API key" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
