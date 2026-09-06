// Browser → http://localhost:11434 directly. Used for local chat + local
// embeddings (default nomic-embed-text). Zero server-side inference.
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, EmbedOptions } from "./types";

export const OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_CHAT_MODEL = "gemma4:26b-a4b-it-qat";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export class OllamaProvider implements AIProvider {
  readonly id = "ollama" as const;
  constructor(private baseUrl: string = OLLAMA_BASE_URL) {}

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama unreachable at ${this.baseUrl} (is 'ollama serve' running?)`);
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: !options.onToken ? false : true,
        options: {
          temperature: options.temperature ?? 0.0,
          ...(options.numCtx ? { num_ctx: options.numCtx } : {}),
          ...(options.numPredict ? { num_predict: options.numPredict } : {}),
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);
    if (options.onToken && res.body) {
      // Streaming NDJSON path
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            const token = evt?.message?.content ?? "";
            if (token) {
              full += token;
              options.onToken(token);
            }
          } catch {
            /* skip partial line */
          }
        }
      }
      return { content: full, provider: "ollama", model: options.model };
    }
    const data = await res.json();
    const content: string = data?.message?.content ?? "";
    return { content, provider: "ollama", model: options.model };
  }

  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: options?.model ?? DEFAULT_EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embedding failed: ${res.status}`);
    const data = await res.json();
    return data.embedding as number[];
  }
}
