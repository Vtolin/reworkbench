// Browser → Vercel API route (BYOK) → cloud provider. Vercel proxies with the
// member's OWN stored/entered key; never a shared workspace key.
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, EmbedOptions } from "./types";

export type CloudProviderId = "openai" | "anthropic" | "google" | "deepseek";

export const CLOUD_PROVIDERS: Array<{ id: CloudProviderId; label: string; hint: string }> = [
  { id: "openai", label: "OpenAI", hint: "e.g. gpt-4o-mini" },
  { id: "deepseek", label: "DeepSeek", hint: "e.g. deepseek-chat" },
  { id: "google", label: "Google", hint: "e.g. gemini-2.5-flash" },
  { id: "anthropic", label: "Anthropic", hint: "e.g. claude-3-5-haiku-latest" },
];

// Live model ids from the provider, authenticated with the member's OWN
// stored key (server-side). Nothing hardcoded — pass-through errors included.
export async function listCloudModels(provider: CloudProviderId): Promise<string[]> {
  const res = await fetch(`/api/ai/proxy/models?provider=${encodeURIComponent(provider)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Model list failed: ${res.status}`);
  return (data as { models: string[] }).models ?? [];
}

export class CloudProvider implements AIProvider {
  readonly id = "cloud" as const;
  constructor(
    private cloudProvider: CloudProviderId = "openai",
    private proxyUrl: string = "/api/ai/proxy",
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    // thinkingBudget/thinkLevel ride along for backends that support them
    // (Google extra_body thinking_config); other providers ignore them.
    const { thinkingBudget, thinkLevel } = options;
    const res = await fetch(this.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        provider: this.cloudProvider,
        model: options.model,
        messages,
        temperature: options.temperature ?? 0.0,
        ...(typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
        ...(typeof thinkLevel === "string" ? { thinkLevel } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Cloud proxy failed: ${res.status}`);
    }
    const data = await res.json();
    return { content: data.content as string, provider: "cloud", model: options.model };
  }

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const res = await fetch("/api/rag/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: "server", model: options?.model }),
    });
    if (!res.ok) throw new Error(`Server embedding failed: ${res.status}`);
    const data = await res.json();
    return data.embedding as number[];
  }
}
