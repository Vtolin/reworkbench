// AIProvider abstraction. The browser orchestrates: fetch context from
// Supabase, generate via the selected provider, write the result back.
// Vercel never calls a user's localhost — Ollama calls originate in-browser.

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  numCtx?: number;
  /** Desired output length. Ollama `num_predict`; forwarded as `max_tokens`
   *  on the cloud proxy (otherwise cloud providers use their own default). */
  numPredict?: number;
  /** Explicit thinking switch. Must be forwarded (not dropped): `false`
   *  means cold/deterministic — on Gemini this maps to `minimal` (3.x) or
   *  `thinking_budget:0` (2.5) instead of the provider default `medium`. */
  thinking?: boolean;
  /** Effort level. `minimal` is the closest-to-off level on Gemini 3;
   *  on Ollama it behaves like `low` (brief trace). Sent only when thinking
   *  is on; never send a bare budget/level on cold calls. */
  thinkLevel?: "minimal" | "low" | "medium" | "high" | "max";
  /** Target thinking-token budget. Forwarded to backends that support it
   *  (Google `extra_body` thinking_config); otherwise ignored. Soft target,
   *  not a hard cap — size `numPredict` so the answer survives regardless. */
  thinkingBudget?: number;
  /** Opt-in structured output. When true the proxy sends
   *  `response_format:{type:"json_object"}` on OpenAI-compat providers.
   *  Makalah JSON calls always set this; free-form chat never does. */
  jsonMode?: boolean;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onThinking?: (delta: string) => void;
}

export interface ChatResult {
  content: string;
  thinking?: string;
  provider: "ollama" | "cloud";
  model: string;
}

export interface EmbedOptions {
  model?: string;
}

export interface AIProvider {
  readonly id: "ollama" | "cloud";
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  listModels?(): Promise<string[]>;
}
