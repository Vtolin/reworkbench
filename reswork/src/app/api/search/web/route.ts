import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { encryptApiKey } from "@/lib/ai/keys";
import { resolveApiKey } from "@/lib/ai/providers";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { getRequestId, withRequestId } from "@/app/api/_lib/request";
import {
  filterAndRankWebResults,
  WEB_SEARCH_PROVIDERS,
  type WebFilterMode,
  type WebSearchProviderId,
} from "@/lib/search/webFilter";
import { executeProviderWebSearch, WebSearchProviderError } from "@/lib/search/providers";
import { TimeoutError } from "@/lib/async/net";

function isWebSearchProvider(value: unknown): value is WebSearchProviderId {
  return (
    typeof value === "string" &&
    (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value)
  );
}

function normalizeFilterMode(value: unknown): WebFilterMode {
  return value === "strict_academic" ? "strict_academic" : "balanced";
}

// GET /api/search/web - reports which web search providers have a saved key
// for the signed-in user (provider names only, never ciphertext or keys).
export async function GET() {
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) {
    return NextResponse.json({ configuredProviders: [] });
  }
  const { data, error } = await supabase
    .from("ai_credentials")
    .select("provider")
    .eq("user_id", me.user.id)
    .in("provider", [...WEB_SEARCH_PROVIDERS]);

  if (error) {
    return NextResponse.json({ configuredProviders: [] });
  }
  const configuredProviders = (data ?? [])
    .map((row) => (row as { provider?: unknown }).provider)
    .filter(isWebSearchProvider);
  return NextResponse.json({ configuredProviders });
}

// PUT /api/search/web { provider, apiKey } - save encrypted BYOK web search key.
export async function PUT(req: Request) {
  let body: { provider?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isWebSearchProvider(body.provider)) {
    return NextResponse.json({ error: "Unsupported web search provider" }, { status: 400 });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { ciphertext, iv } = encryptApiKey(apiKey);
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
    return NextResponse.json({ error: "Could not save web search key" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, provider: body.provider });
}

// DELETE /api/search/web { provider } - forget stored BYOK web search key.
export async function DELETE(req: Request) {
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { provider?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isWebSearchProvider(body.provider)) {
    return NextResponse.json({ error: "Unsupported web search provider" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ai_credentials")
    .delete()
    .eq("user_id", me.user.id)
    .eq("provider", body.provider);

  if (error) {
    return NextResponse.json({ error: "Could not remove web search key" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, provider: body.provider });
}

// POST /api/search/web { query, provider, filterMode?, maxResults? }
// Runs authenticated BYOK web search + Anti-AI-Slop filtering before returning
// results to any local or cloud model prompt.
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) {
    return withRequestId(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), requestId);
  }

  const limited = await enforceRateLimit(req, "web-search", { userId: me.user.id, requestId });
  if (limited) return withRequestId(limited, requestId);

  let body: {
    query?: unknown;
    provider?: unknown;
    filterMode?: unknown;
    maxResults?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return withRequestId(NextResponse.json({ error: "Invalid JSON" }, { status: 400 }), requestId);
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 500) {
    return withRequestId(
      NextResponse.json({ error: "query is required (1-500 chars)" }, { status: 400 }),
      requestId,
    );
  }
  if (!isWebSearchProvider(body.provider)) {
    return withRequestId(
      NextResponse.json({ error: "Unsupported web search provider" }, { status: 400 }),
      requestId,
    );
  }

  const resolved = await resolveApiKey(undefined, body.provider);
  if (!resolved.key) {
    return withRequestId(
      NextResponse.json(
        {
          error:
            resolved.status === 400
              ? `No Web Search API key saved for ${body.provider}. Add one in Settings → Web Search.`
              : resolved.error || "Could not load Web Search API key",
        },
        { status: resolved.status ?? 400 },
      ),
      requestId,
    );
  }

  const filterMode = normalizeFilterMode(body.filterMode);
  const maxResults =
    typeof body.maxResults === "number" && Number.isFinite(body.maxResults)
      ? Math.min(10, Math.max(1, Math.floor(body.maxResults)))
      : 6;

  try {
    // Request slightly more raw results so anti-slop filtering still leaves rich matches.
    const raw = await executeProviderWebSearch(
      body.provider,
      resolved.key,
      query,
      Math.min(10, maxResults + 3),
    );
    const { results, filteredOutCount } = filterAndRankWebResults(raw, {
      mode: filterMode,
      maxResults,
    });
    return withRequestId(
      NextResponse.json({
        results,
        filteredOutCount,
        provider: body.provider,
        filterMode,
      }),
      requestId,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      return withRequestId(
        NextResponse.json({ error: "Web search timed out" }, { status: 504 }),
        requestId,
      );
    }
    if (err instanceof WebSearchProviderError) {
      return withRequestId(
        NextResponse.json({ error: err.message }, { status: err.status }),
        requestId,
      );
    }
    return withRequestId(
      NextResponse.json({ error: "Web search failed" }, { status: 502 }),
      requestId,
    );
  }
}
