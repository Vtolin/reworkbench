// Makalah validation (spec steps 1-4): citation integrity + claim check.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import type { InferenceSelection } from "../ask";
import { chatJson, extractJsonObject } from "./json";
import { pickMakalahStage } from "./stages";
import { cleanPassageForPrompt } from "./citations";
import { MAKALAH_SHARED_SYSTEM } from "./prompts";
import type { SectionOutput, SectionPassage } from "./types";

export function validateSectionCitations(
  output: SectionOutput,
  passages: SectionPassage[],
): { ok: boolean; total: number; valid: number; badIds: string[]; badPages: string[] } {
  const allowed = new Set(passages.map((p) => p.source_id));
  const validPages = new Set(
    passages
      .filter((p) => p.page !== null && p.page !== undefined)
      .map((p) => `${p.source_id}@p.${p.page}`),
  );
  // Sources whose passages carry no page info at all (legacy chunks ingested
  // before page-aware chunking) cannot be page-verified — flagging every
  // cited page for them is a false-positive wall, so skip those sources.
  const unverifiable = new Set(
    [...allowed].filter(
      (id) => !passages.some((p) => p.source_id === id && p.page !== null && p.page !== undefined),
    ),
  );
  let total = 0;
  let valid = 0;
  const bad = new Set<string>();
  const badPages = new Set<string>();
  for (const para of output.paragraphs) {
    for (const c of para.citations) {
      total += 1;
      if (c.source_id && allowed.has(c.source_id)) {
        valid += 1;
        if (c.page !== null && c.page !== undefined && !unverifiable.has(c.source_id)) {
          const key = `${c.source_id}@p.${c.page}`;
          if (!validPages.has(key)) {
            badPages.add(key);
          }
        }
      } else if (c.source_id) {
        bad.add(c.source_id);
      }
    }
  }
  return { ok: bad.size === 0, total, valid, badIds: [...bad], badPages: [...badPages] };
}

// ---------------------------------------------------------------------------
// Claim-support check — optional narrow LLM classifier (spec §6 step 4).
// One paragraph + its cited passages -> supported / not_supported.
// No memory of the rest of the document.
// ---------------------------------------------------------------------------

export async function claimSupportCheck(
  paragraphText: string,
  citedPassages: SectionPassage[],
  sel: InferenceSelection,
): Promise<{ verdict: "supported" | "not_supported"; reason: string }> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahSectionStage);
  const evidence =
    citedPassages.map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${cleanPassageForPrompt(p.text)}`).join("\n\n") ||
    "(no cited passages)";
  const user =
    `Answer only "supported" or "not_supported" — does the passage text ` +
    `justify the claim in the paragraph? Return JSON: ` +
    `{"verdict": "...", "reason": "..."}\n\n` +
    `Paragraph:\n${paragraphText}\n\nPassages:\n${evidence}`;
  try {
    const obj = await chatJson<Record<string, unknown>>(
      provider, model, MAKALAH_SHARED_SYSTEM, user,
      sel.numCtx, 512,
      (t) => extractJsonObject(t) as Record<string, unknown>,
      "Claim check",
      false,
    );
    const verdict =
      String(obj.verdict ?? "").toLowerCase().includes("not") ?
        "not_supported"
      : "supported";
    return { verdict, reason: String(obj.reason ?? "") };
  } catch {
    return { verdict: "not_supported", reason: "Classifier output was not valid JSON after retry" };
  }
}

// ---------------------------------------------------------------------------
// Bibliography — deterministic, from stored metadata (APA-ish plain text)
// ---------------------------------------------------------------------------
