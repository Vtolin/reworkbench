// Makalah JSON hardening + parsing + bounded model-JSON calls.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import type { AIProvider } from "../../ai/types";
import type { MakalahOutline, OutlineChapter, SectionOutput } from "./types";

export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/** Escape raw/unescaped control characters (\n, \r, \t) inside double-quoted string literals. */
function escapeControlCharsInStrings(text: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

/**
 * Repair conservatively:
 * 1. Escape raw unescaped control characters (\n, \r, \t) inside string
 *    literals (LLMs emit literal newlines; JSON.parse rejects them).
 * 2. Remove trailing commas before } or ] — the most common LLM JSON defect.
 *
 * Deliberately NOT normalizing single-quoted JSON: the '…'-to-"…" rewrite
 * corrupts legitimate apostrophes (Today's, peneliti's) whenever a model
 * answers with zero double-quotes, turning a recoverable parse into silent
 * text corruption. A single-quoted answer fails fast with an actionable
 * message instead.
 */
export function repairJson(text: string): string {
  let res = text;
  res = escapeControlCharsInStrings(res);
  res = res.replace(/,(\s*[}\]])/g, "$1");
  return res;
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripFences(text);
  const candidates: string[] = [cleaned];
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy && greedy[0] !== cleaned) candidates.push(greedy[0]);
  let firstErr = "";
  for (const c of candidates) {
    for (const variant of [c, repairJson(c)]) {
      try {
        return JSON.parse(variant) as Record<string, unknown>;
      } catch (e) {
        if (!firstErr) firstErr = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(
    `Model did not return valid JSON (${firstErr || "no object found"}). Raw start: ${cleaned.slice(0, 200)}`,
  );
}

/**
 * Bounded JSON retry: one normal attempt, then (only on parse failure) one
 * correction attempt that shows the model its own bad output. Still fully
 * app-controlled — fixed max 2 calls, no autonomy. The thrown error carries
 * the last raw output as `(err as { raw?: string }).raw` for salvage paths.
 */
export async function chatJson<T>(
  provider: AIProvider,
  model: string,
  system: string,
  user: string,
  numCtx: number,
  numPredict: number,
  parse: (t: string) => T,
  label: string,
  think: boolean | "minimal" | "low" | "medium" | "high" | "max" = false,
  thinkingBudget?: number,
  signal?: AbortSignal,
  temperature = 0,
): Promise<T> {
  let lastRaw = "";
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1 ? user : (
        `${user}\n\nIMPORTANT: Your previous response was not valid JSON (${lastErr}). ` +
        `Reply now with ONLY the corrected JSON object — no preamble, no fences, no commentary. ` +
        `Fix this response:\n${lastRaw.slice(0, 6000)}`
      );
    const r = await provider.chat(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      {
        model, temperature, numCtx, numPredict, thinking: think !== false,
        ...(typeof think === "string" ? { thinkLevel: think } : {}),
        // A bare budget ENABLES thinking on Gemini — only send it together
        // with thinking on, never on cold calls. Cold calls send
        // thinking:false explicitly so the proxy maps to minimal/0 instead
        // of the provider default (medium on gemini-3.5-flash).
        ...(think !== false && typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
        // Structured output on cloud (OpenAI-compat response_format).
        // Ollama ignores unknown flags — it enforces JSON via prompt.
        jsonMode: true,
        ...(signal ? { signal } : {}),
      },
    );
    lastRaw = (r.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Reasoning models can burn the whole token budget thinking and return an
    // empty answer (native `thinking` field or a think-only block). Retrying
    // won't help — fail fast with an actionable message instead.
    if (!lastRaw) {
      const thought = (r.thinking ?? "").trim();
      const err = new Error(
        thought ?
          `${label}: model returned only reasoning with no answer (token budget spent thinking). ` +
            `Use a non-reasoning model for this Makalah stage in Settings, or raise num_ctx / output length.`
        : `${label}: model returned empty output. The model may be overloaded or still loading — wait a moment and retry.`,
      ) as Error & { raw?: string };
      err.raw = "";
      throw err;
    }
    try {
      return parse(lastRaw);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  const err = new Error(`${label} failed after retry: ${lastErr}`) as Error & { raw?: string };
  err.raw = lastRaw;
  throw err;
}

// ---------------------------------------------------------------------------
// Mode A — Outline Generator
// ---------------------------------------------------------------------------

export function parseOutlineJson(text: string): MakalahOutline {
  const obj = extractJsonObject(text);
  const rawChapters = Array.isArray(obj.outline) ? obj.outline : [];
  const outline: OutlineChapter[] = rawChapters.map((c) => {
    const ch = c as Record<string, unknown>;
    const rawSubs = Array.isArray(ch.subsections) ? ch.subsections : [];
    return {
      chapter_number: String(ch.chapter_number ?? ""),
      chapter_title: String(ch.chapter_title ?? ""),
      ...(ch.synthesis_only === true ? { synthesis_only: true as const } : {}),
      subsections: rawSubs.map((s) => {
        const sub = s as Record<string, unknown>;
        const likely = Array.isArray(sub.likely_sources)
          ? (sub.likely_sources as unknown[]).map(String)
          : undefined;
        const ids = Array.isArray(sub.source_ids)
          ? (sub.source_ids as unknown[]).map(String)
          : undefined;
        const noCover = Array.isArray(sub.must_not_cover)
          ? (sub.must_not_cover as unknown[]).map(String).filter(Boolean).slice(0, 8)
          : undefined;
        return {
          number: String(sub.number ?? ""),
          title: String(sub.title ?? ""),
          ...(likely ? { likely_sources: likely } : {}),
          ...(ids ? { source_ids: ids } : {}),
          ...(typeof sub.focus === "string" && sub.focus.trim()
            ? { focus: sub.focus.trim().slice(0, 300) }
            : {}),
          ...(noCover?.length ? { must_not_cover: noCover } : {}),
        };
      }),
    };
  });
  return {
    outline,
    coverage_notes:
      typeof obj.coverage_notes === "string" ? obj.coverage_notes : "",
  };
}

export function parseSectionJson(text: string): SectionOutput {
  const obj = extractJsonObject(text);
  const raw = Array.isArray(obj.paragraphs) ? obj.paragraphs : [];
  return {
    paragraphs: raw.map((p) => {
      const para = p as Record<string, unknown>;
      const rawCites = Array.isArray(para.citations) ? para.citations : [];
      return {
        text: String(para.text ?? ""),
        citations: rawCites.map((c) => {
          const cite = c as Record<string, unknown>;
          const page =
            typeof cite.page === "number"
              ? cite.page
              : Number(cite.page) || null;
          return { source_id: String(cite.source_id ?? ""), page };
        }),
      };
    }),
    gaps: typeof obj.gaps === "string" ? obj.gaps : "",
  };
}

/** Document-level context threaded into section drafting (all optional). */
