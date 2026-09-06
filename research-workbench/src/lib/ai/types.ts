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
  numPredict?: number;
  thinking?: boolean;
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
