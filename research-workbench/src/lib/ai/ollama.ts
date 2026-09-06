// Browser → http://localhost:11434 directly. Used for local chat + local
// embeddings (default nomic-embed-text). Zero server-side inference.
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, EmbedOptions } from "./types";

export const OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_CHAT_MODEL = "gemma4:26b-a4b-it-qat";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export interface OllamaChatOptions extends ChatOptions {
  thinking?: boolean;
}

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
    const thinking = (options as OllamaChatOptions).thinking ?? false;
    try {
      return await this.doChat(messages, options, thinking);
    } catch (e) {
      // Non-thinking models (e.g. qwen2.5:1.5b) reject think=true with 400.
      // Retry once without thinking so the ask still succeeds, and say so in
      // the thinking box instead of failing the whole request.
      if (thinking && e instanceof Error && /failed: 400/.test(e.message)) {
        const fallback = await this.doChat(messages, options, false);
        return {
          ...fallback,
          thinking: `Thinking mode is not supported by ${options.model} — answered directly. Use a reasoning model (e.g. deepseek-r1) or turn off the Thinking toggle.`,
        };
      }
      throw e;
    }
  }

  private async doChat(messages: ChatMessage[], options: ChatOptions, thinking: boolean): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        model: options.model,
        messages: thinking
          ? [{ role: "system", content: "Think step-by-step inside <think> tags, then answer." }, ...messages]
          : messages,
        stream: !options.onToken ? false : true,
        // Omit `think` entirely unless requested: some models/versions
        // reject the field even when false.
        ...(thinking ? { think: true } : {}),
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
      let thinkingText = "";
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
            const thinkDelta = evt?.message?.thinking ?? "";
            if (thinkDelta) {
              thinkingText += thinkDelta;
              options.onThinking?.(thinkDelta);
            }
            if (token) {
              full += token;
              options.onToken(token);
            }
          } catch {
            /* skip partial line */
          }
        }
      }
      // Non-stream-thinking fallback: split <think> tags out of the text.
      if (!thinkingText) {
        const m = full.match(/<think>([\s\S]*?)<\/think>/i);
        if (m) {
          thinkingText = m[1].trim();
          full = full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        }
      }
      return { content: full, thinking: thinkingText || undefined, provider: "ollama", model: options.model };
    }
    const data = await res.json();
    let content: string = data?.message?.content ?? "";
    let thinkingText: string | undefined =
      typeof data?.message?.thinking === "string" ? data.message.thinking : undefined;
    if (!thinkingText) {
      const m = content.match(/<think>([\s\S]*?)<\/think>/i);
      if (m) {
        thinkingText = m[1].trim();
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      }
    }
    return { content, thinking: thinkingText, provider: "ollama", model: options.model };
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
