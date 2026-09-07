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
