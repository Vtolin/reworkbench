import { describe, expect, it } from "vitest";
import {
  credentialForProvider,
  selectEmbeddingCredential,
  type StoredCredential,
} from "./credential-select";

function cred(provider: string): StoredCredential {
  return { provider, ciphertext: "c", iv: "i" };
}

describe("credentialForProvider", () => {
  it("finds the exact provider case-insensitively", () => {
    expect(credentialForProvider([cred("openai"), cred("google")], "OpenAI")).toEqual(cred("openai"));
  });

  it("returns null for unsaved or absent providers", () => {
    expect(credentialForProvider([cred("openai")], "anthropic")).toBeNull();
    expect(credentialForProvider([cred("openai")], "")).toBeNull();
    expect(credentialForProvider([cred("openai")], null)).toBeNull();
  });
});

describe("selectEmbeddingCredential", () => {
  it("prefers the explicitly requested provider when saved", () => {
    const rows = [cred("openai"), cred("google")];
    expect(selectEmbeddingCredential(rows, "google")).toEqual(cred("google"));
  });

  it("treats a lone key as unambiguous, even without embedding support", () => {
    // Preserved embed behavior: the route reports "no embedding API" for
    // the lone key rather than failing selection silently.
    expect(selectEmbeddingCredential([cred("anthropic")], "")).toEqual(cred("anthropic"));
  });

  it("falls back to OpenAI, then Google, across several keys", () => {
    expect(selectEmbeddingCredential([cred("google"), cred("openai")], "")).toEqual(cred("openai"));
    expect(selectEmbeddingCredential([cred("google"), cred("deepseek")], "")).toEqual(cred("google"));
  });

  it("returns null when no stored row can serve embeddings", () => {
    expect(selectEmbeddingCredential([cred("deepseek"), cred("anthropic")], "")).toBeNull();
    expect(selectEmbeddingCredential([], "openai")).toBeNull();
  });

  it("falls back across providers when the requested one was never saved", () => {
    // Preserved embed behavior: an unsaved explicit request does not fail
    // selection outright; the OpenAI/Google fallback still applies.
    expect(selectEmbeddingCredential([cred("openai")], "deepseek")).toEqual(cred("openai"));
  });
});
