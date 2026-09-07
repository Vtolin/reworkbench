import { NextResponse } from "next/server";
import { OPENAI_COMPAT_BASE, KNOWN_PROVIDERS, resolveApiKey } from "@/lib/ai/providers";

// GET /api/ai/proxy/models?provider=deepseek — live model list from the
// provider, authenticated with the member's OWN stored key. Nothing hardcoded.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider") ?? "";
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Unsupported provider: ${provider || "(none)"}` }, { status: 400 });
  }
  const { key: apiKey, error, status } = await resolveApiKey(undefined);
  if (!apiKey) return NextResponse.json({ error }, { status: status ?? 500 });
  try {
    if (provider === "anthropic") {
      const upstream = await fetch("https://api.anthropic.com/v1/models?limit=50", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (!upstream.ok) return NextResponse.json({ error: `Anthropic error: ${upstream.status}` }, { status: 502 });
      const data = await upstream.json();
      const models = ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort();
      return NextResponse.json({ models });
    }
    const upstream = await fetch(`${OPENAI_COMPAT_BASE[provider]}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!upstream.ok) return NextResponse.json({ error: `${provider} error: ${upstream.status}` }, { status: 502 });
    const data = await upstream.json();
    const models = ((data.data ?? []) as Array<{ id: string }>).map((m) => m.id).sort();
    return NextResponse.json({ models });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Model list failed" }, { status: 500 });
  }
}
