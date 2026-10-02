// Makalah model routing per pipeline stage.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { OllamaProvider } from "../../ai/ollama";
import { CloudProvider } from "../../ai/cloud";
import type { AIProvider } from "../../ai/types";
import type { InferenceSelection, StageSelection } from "../ask";

function pickProvider(sel: InferenceSelection): { provider: AIProvider; model: string } {
  if (sel.provider === "ollama") return { provider: new OllamaProvider(), model: sel.model };
  return { provider: new CloudProvider(sel.cloudProvider), model: sel.cloudModel };
}

/** Resolve one makalah pipeline stage. "inherit"/empty falls back to main chat selection. */
export function pickMakalahStage(
  sel: InferenceSelection,
  stage: StageSelection | undefined,
): { provider: AIProvider; model: string; label: string } {
  const mainLabel =
    sel.provider === "ollama" ? `ollama:${sel.model}` : `${sel.cloudProvider}:${sel.cloudModel}`;
  if (!stage || stage.provider === "inherit") {
    const { provider, model } = pickProvider(sel);
    return { provider, model, label: mainLabel };
  }
  if (stage.provider === "ollama") {
    const model = stage.model.trim() || sel.model;
    return { provider: new OllamaProvider(), model, label: `ollama:${model}` };
  }
  const cp = stage.cloudProvider || sel.cloudProvider;
  const model = stage.cloudModel.trim() || sel.cloudModel;
  return { provider: new CloudProvider(cp), model, label: `${cp}:${model}` };
}

/** Labels for UI display (Settings + Makalah setup step). */
export function makalahStageLabels(sel: InferenceSelection): { outline: string; section: string } {
  return {
    outline: pickMakalahStage(sel, sel.makalahOutlineStage).label,
    section: pickMakalahStage(sel, sel.makalahSectionStage).label,
  };
}

/** Per-call output cap, clamped so a typo can't produce empty/truncated JSON. */
export function makalahBudget(sel: InferenceSelection): number {
  const n = sel.makalahNumPredict ?? 3072;
  return Math.min(16384, Math.max(256, n));
}

/** Thinking-token budget for drafting, clamped so typos can't starve answers. */
export function makalahThinkBudget(sel: InferenceSelection): number {
  return Math.min(4096, Math.max(128, sel.makalahThinkingBudget ?? 1024));
}
