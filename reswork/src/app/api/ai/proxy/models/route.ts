import { NextResponse } from "next/server";
import { OPENAI_COMPAT_BASE, KNOWN_PROVIDERS, resolveApiKey, upstreamError } from "@/lib/ai/providers";
import { fetchWithTimeout } from "@/lib/async/net";
import { getRequestId, logRequest, withRequestId } from "@/app/api/_lib/request";

// Upstream-call policy: every provider fetch has an explicit 15s deadline so
// a half-open socket cannot hang the serverless function. No retry here —
// model-list GETs are cheap but caller-driven; failures surface to the user.
// Auth is enforced via resolveApiKey BEFORE any upstream call: anonymous
// callers get 401, callers with no stored key get 400 — never an upstream
// fetch with a missing key.
const MODELS_TIMEOUT_MS = 15_000;

// GET /api/ai/proxy/models?provider=deepseek — live model list from the
// provider, authenticated with the member's OWN stored key. Nothing hardcoded.
export async function GET(req: Request) {
  const requestId = getRequestId(req); // Phase 7: completion below carries this.
  const started = Date.now();
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") ?? "";
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return withRequestId(
      NextResponse.json({ error: `Unsupported provider: ${provider || "(none)"}` }, { status: 400 }),
      requestId,
    );
  }
  const { key: apiKey, error, status } = await resolveApiKey(undefined, provider);
  if (!apiKey) {
    return withRequestId(NextResponse.json({ error }, { status: status ?? 500 }), requestId);
  }
  try {
    if (provider === "anthropic") {
      const upstream = await fetchWithTimeout(
        "https://api.anthropic.com/v1/models?limit=50",
        {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        },
        MODELS_TIMEOUT_MS,
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        logRequest(requestId, "ai.proxy.models", started, false, { status: upstream.status });
        return withRequestId(
          NextResponse.json({ error: upstreamError("Anthropic", upstream.status, text) }, { status: 502 }),
          requestId,
        );
      }
      const data = await upstream.json();
      const models = ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort();
      logRequest(requestId, "ai.proxy.models", started, true, { provider, count: models.length });
      return withRequestId(NextResponse.json({ models }), requestId);
    }
    const upstream = await fetchWithTimeout(
      `${OPENAI_COMPAT_BASE[provider]}/models`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      MODELS_TIMEOUT_MS,
    );
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      logRequest(requestId, "ai.proxy.models", started, false, { status: upstream.status });
      return withRequestId(
        NextResponse.json({ error: upstreamError(provider, upstream.status, text) }, { status: 502 }),
        requestId,
      );
    }
    const data = await upstream.json();
    const models = ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort();
    logRequest(requestId, "ai.proxy.models", started, true, { provider, count: models.length });
    return withRequestId(NextResponse.json({ models }), requestId);
  } catch {
    logRequest(requestId, "ai.proxy.models", started, false, {});
    return withRequestId(NextResponse.json({ error: "Model list failed" }, { status: 500 }), requestId);
  }
}
