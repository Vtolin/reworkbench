import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { decryptApiKey } from "@/lib/ai/keys";

// Provider registry. `openai` / `deepseek` / `google` all speak the
// OpenAI-compatible dialect (different base URLs, same shape); `anthropic`
// has its own native API and is special-cased by callers.
// Model ids are NEVER hardcoded — clients send the model string, and the
// models route lists live models using the member's own key.
export const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export const KNOWN_PROVIDERS = [...Object.keys(OPENAI_COMPAT_BASE), "anthropic"];

// ---------------------------------------------------------------------------
// Google thinking controls (pure helpers — unit-tested without a key).
// Gemini 2.5 takes a token budget, Gemini 3 takes a categorical level; the
// two overlap and must never be sent together. Levels map to budgets the way
// Google's own OpenAI-compat docs map reasoning effort:
// minimal → 0/off, low → 1024, medium → 8192, high/max → 24576.
// Cold/deterministic calls MUST pass thinking:false explicitly so Gemini
// does not fall back to its provider default (medium on 3.5-flash).
// ---------------------------------------------------------------------------

export type GeminiThinkLevel = "minimal" | "low" | "medium" | "high" | "max";

const GEMINI_LEVEL_TO_BUDGET: Record<GeminiThinkLevel, number> = {
  minimal: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  max: 24576,
};

const GEMINI_LEVEL_TO_L3: Record<GeminiThinkLevel, "minimal" | "low" | "medium" | "high"> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

export function isGemini3(model: string): boolean {
  return /^gemini-3/i.test((model ?? "").trim());
}

export function buildGoogleExtraBody(opts: {
  model: string;
  thinking?: boolean;
  thinkingBudget?: number;
  thinkLevel?: GeminiThinkLevel;
}): Record<string, unknown> | undefined {
  const hasBudget = typeof opts.thinkingBudget === "number" && Number.isFinite(opts.thinkingBudget);
  const hasLevel = typeof opts.thinkLevel === "string" && !!opts.thinkLevel;
  if (isGemini3(opts.model)) {
    // Gemini 3: levels only (budgets "may result in unexpected performance").
    // Explicit thinking:false maps to `minimal` (closest to off — full off
    // is unsupported on 3.x). Absent flag with no level/budget leaves the
    // provider default untouched (medium on 3.5-flash).
    if (opts.thinking === false) return { google: { thinking_config: { thinking_level: "minimal" } } };
    const level = hasLevel ? GEMINI_LEVEL_TO_L3[opts.thinkLevel as GeminiThinkLevel] : undefined;
    if (!level) return undefined;
    return { google: { thinking_config: { thinking_level: level } } };
  }
  // Gemini 2.5 and earlier: numeric budget (0 disables thinking on Flash).
  if (opts.thinking === false && !hasBudget && !hasLevel) {
    return { google: { thinking_config: { thinking_budget: 0 } } };
  }
  if (hasBudget) {
    const n = Math.min(32768, Math.max(0, Math.floor(opts.thinkingBudget as number)));
    return { google: { thinking_config: { thinking_budget: n } } };
  }
  if (hasLevel) {
    return { google: { thinking_config: { thinking_budget: GEMINI_LEVEL_TO_BUDGET[opts.thinkLevel as GeminiThinkLevel] } } };
  }
  return undefined;
}

/** Shape an upstream failure into a diagnosable (key-free) message. */
export function upstreamError(provider: string, status: number, bodyText: string): string {
  let msg = `${provider} error: ${status}`;
  const text = (bodyText ?? "").trim();
  if (!text) return msg;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    const detail =
      typeof j.error === "string" ? j.error : j.error?.message;
    if (detail) return `${msg} — ${String(detail).slice(0, 300)}`;
  } catch {
    /* not JSON — fall through to raw text */
  }
  return `${msg} — ${text.slice(0, 200)}`;
}

export async function resolveApiKey(provided: string | undefined): Promise<{ key?: string; error?: string; status?: number }> {
  if (provided) return { key: provided };
  const supabase = await createServerSupabase();
  const { data: me } = await supabase.auth.getUser();
  if (!me.user) return { error: "Unauthorized", status: 401 };
  const service = createServiceSupabase();
  const { data: cred } = await service
    .from("ai_credentials")
    .select("ciphertext, iv, provider")
    .eq("user_id", me.user.id)
    .maybeSingle();
  if (!cred) {
    return {
      error: "No cloud API key saved. Add one in Settings → Cloud provider.",
      status: 400,
    };
  }
  try {
    const c = cred as { ciphertext: string; iv: string };
    return { key: decryptApiKey(c.ciphertext, c.iv) };
  } catch {
    return { error: "Stored key could not be decrypted", status: 500 };
  }
}
