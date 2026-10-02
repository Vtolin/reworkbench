import { afterAll, describe, expect, it, vi } from "vitest";
import { decryptApiKey, encryptApiKey } from "./keys";

// keys.ts reads CREDENTIALS_ENCRYPTION_KEY per call; stub it so these tests
// never depend on ambient env and never touch a real credential.
const TEST_KEY = "phase-3-test-encryption-key-long-enough";

vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", TEST_KEY);
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("BYOK key encryption round-trip", () => {
  it("decrypts what it encrypts", () => {
    const { ciphertext, iv } = encryptApiKey("sk-test-secret");
    expect(decryptApiKey(ciphertext, iv)).toBe("sk-test-secret");
  });

  it("uses a fresh random IV per encryption", () => {
    const a = encryptApiKey("same-plaintext");
    const b = encryptApiKey("same-plaintext");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(decryptApiKey(b.ciphertext, b.iv)).toBe("same-plaintext");
  });

  it("fails closed on tampered ciphertext or a wrong key", () => {
    const { ciphertext, iv } = encryptApiKey("sk-test-secret");
    // Flip the first char to a *different* valid base64 char: naively
    // overwriting with "X" is a no-op ~1/64 of the time (ciphertext already
    // starts with "X"), which made this test flaky.
    const tamperedFirst = ciphertext[0] === "A" ? "B" : "A";
    expect(() => decryptApiKey(`${tamperedFirst}${ciphertext.slice(1)}`, iv)).toThrow();
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "a-different-test-key-long-enough");
    expect(() => decryptApiKey(ciphertext, iv)).toThrow();
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", TEST_KEY);
  });
});
