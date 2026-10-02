import { NextResponse } from "next/server";

// Server-side byte caps (Phase 3). Every capped field is measured as UTF-8
// bytes of its canonical JSON encoding (TextEncoder), not JS string length
// (multibyte chars would otherwise slip past). Over-limit requests get 413,
// never a truncated write or a masked 500.

// Trail events are small metadata facts; 32KB leaves ample headroom.
export const TRAIL_PAYLOAD_MAX_BYTES = 32 * 1024;
// Proxy conversations carry history; 256KB covers long threads while
// bounding billed upstream bodies.
export const PROXY_MESSAGES_MAX_BYTES = 256 * 1024;

/** UTF-8 byte length of the canonical JSON encoding. Pure. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

/** True when the value exceeds maxBytes. Pure. */
export function isOverLimit(value: unknown, maxBytes: number): boolean {
  return jsonByteLength(value) > maxBytes;
}

/** 413 response for an oversized field. Pure. */
export function tooLargeResponse(field: string, maxBytes: number): NextResponse {
  return NextResponse.json(
    { error: `${field} too large (max ${maxBytes} bytes)` },
    { status: 413 },
  );
}
