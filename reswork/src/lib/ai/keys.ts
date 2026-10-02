// Server-side encryption for BYOK cloud API keys (ai_credentials table).
// AES-GCM with a server-only CREDENTIALS_ENCRYPTION_KEY. Keys are personal
// credentials: never in a public row, never NEXT_PUBLIC_*, owner-only RLS.
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto";

function key(): Buffer {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptApiKey(plaintext: string): { ciphertext: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([tag, enc]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decryptApiKey(ciphertext: string, iv: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const tag = raw.subarray(0, 16);
  const enc = raw.subarray(16);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
