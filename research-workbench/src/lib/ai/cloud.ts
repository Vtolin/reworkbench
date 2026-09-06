// Browser → Vercel API route (BYOK) → cloud provider. Vercel proxies with the
// member's OWN stored/entered key; never a shared workspace key.
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, EmbedOptions } from "./types";

export type CloudProviderId = "openai" | "anthropic" | "google";

export class CloudProvider implements AIProvider {
  readonly id = "cloud" as const;
  constructor(
    private cloudProvider: CloudProviderId = "openai",
    private proxyUrl: string = "/api/ai/proxy",
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const res = await fetch(this.proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        provider: this.cloudProvider,
        model: options.model,
        messages,
        temperature: options.temperature ?? 0.0,
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
