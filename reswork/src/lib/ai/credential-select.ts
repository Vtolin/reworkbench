// Pure BYOK credential selection (no Supabase, no crypto, no network).
//
// The ai_credentials table holds one row per (user_id, provider). These
// helpers encode *which stored row* serves a request; fetching and
// decryption stay in the API routes (rag/embed, ai/proxy). Extracted
// verbatim from the rag/embed pick policy so the behavior is pinned by
// unit tests before the (user_id, provider) cardinality fix lands.

export interface StoredCredential {
  provider: string;
  ciphertext: string;
  iv: string;
}

/** Exact-provider lookup; null when that provider was never saved. */
export function credentialForProvider(
  creds: StoredCredential[],
  provider: string | undefined | null,
): StoredCredential | null {
  const want = (provider ?? "").toLowerCase();
  if (!want) return null;
  return creds.find((c) => c.provider.toLowerCase() === want) ?? null;
}

/**
 * Embedding-backend choice. Policy (mirrors rag/embed):
 * explicit provider wins when saved; otherwise a lone key is unambiguous;
 * several keys prefer one with an embedding API (OpenAI, then Google).
 * Returns null when no stored row can serve embeddings — the caller turns
 * that into the "save an OpenAI or Google key" 400, never a silent miss.
 */
export function selectEmbeddingCredential(
  creds: StoredCredential[],
  requestedProvider: string | undefined | null,
): StoredCredential | null {
  const want = (requestedProvider ?? "").toLowerCase();
  return (
    (want ? creds.find((c) => c.provider === want) : undefined) ??
    (creds.length === 1 ? creds[0] : undefined) ??
    creds.find((c) => c.provider === "openai") ??
    creds.find((c) => c.provider === "google") ??
    null
  );
}
