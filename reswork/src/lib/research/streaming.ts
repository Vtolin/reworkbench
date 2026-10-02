// Research streaming helpers (deterministic, no I/O).
// Extracted verbatim from app/research/page.tsx (Phase 8); behavior unchanged.
export interface ParsedThinking {
  thinking: string | null;
  answer: string;
}

/** Split a streamed answer into its <think> trace and visible content. */
export function parseThinking(raw: string): ParsedThinking {
  const lower = raw.toLowerCase();
  const hasOpen = lower.includes("<think>");
  const hasClose = lower.includes("</think>");
  if (hasOpen && !hasClose) {
    const idx = lower.indexOf("<think>");
    const before = raw.slice(0, idx).trim();
    const inner = raw.slice(idx + 7).trim();
    return { thinking: inner || "", answer: before };
  }
  const m = raw.match(/<think>([\s\S]*?)<\/think>/i);
  if (m) {
    const inner = m[1].trim();
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return { thinking: inner || null, answer: cleaned };
  }
  return { thinking: null, answer: raw.trim() };
}
