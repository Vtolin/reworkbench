import { OllamaProvider } from "@/lib/ai/ollama";

// Model auto-detection for installed Ollama models (browser-side only).
export async function detectOllamaModels(): Promise<{ online: boolean; models: string[] }> {
  try {
    const models = await new OllamaProvider().listModels();
    return { online: true, models };
  } catch {
    return { online: false, models: [] };
  }
}
