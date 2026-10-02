// Feature API: inference + local-device settings.
// Owns the inference snapshot (defaults, coercion, selection mapping) and
// the localStorage-backed config/settings surface. Extracted verbatim from
// lib/api.ts (Phase 5); behavior unchanged.
import type { InferenceSelection } from "../wb/ask";

const INFERENCE_KEY = "rw.inference_settings.v1";
const SETTINGS_KEY = "rw.settings.v1";

export interface StageSnapshot {
  provider: "inherit" | "ollama" | "cloud";
  model: string;
  cloudProvider: "openai" | "anthropic" | "google" | "deepseek";
  cloudModel: string;
}

export interface InferenceSnapshot {
  provider: "ollama" | "cloud";
  model: string;
  embedMode: "local" | "server";
  temperature: number;
  numCtx: number;
  numPredict?: number;
  cloudProvider: "openai" | "anthropic" | "google" | "deepseek";
  cloudModel: string;
  summarizeMethod: "stuff" | "map_reduce";
  mapStage: StageSnapshot;
  reduceStage: StageSnapshot;
  synthesisStage: StageSnapshot;
  makalahOutlineStage: StageSnapshot;
  makalahSectionStage: StageSnapshot;
  makalahThinking: boolean;
  makalahNumPredict: number;
  makalahThinkLevel: "minimal" | "low" | "medium" | "high" | "max";
  makalahThinkingBudget: number;
}

const INHERIT_STAGE_SNAP: StageSnapshot = { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" };

const INFERENCE_DEFAULTS: InferenceSnapshot = {
  provider: "ollama",
  model: "gemma4:26b-a4b-it-qat",
  embedMode: "local",
  temperature: 0.0,
  numCtx: 32768,
  cloudProvider: "openai",
  cloudModel: "gpt-4o-mini",
  summarizeMethod: "stuff",
  mapStage: { ...INHERIT_STAGE_SNAP },
  reduceStage: { ...INHERIT_STAGE_SNAP },
  synthesisStage: { ...INHERIT_STAGE_SNAP },
  makalahOutlineStage: { ...INHERIT_STAGE_SNAP },
  makalahSectionStage: { ...INHERIT_STAGE_SNAP },
  makalahThinking: false,
  makalahNumPredict: 3072,
  makalahThinkLevel: "low" as const,
  makalahThinkingBudget: 1024,
};

const STAGE_PROVIDERS = new Set(["inherit", "ollama", "cloud"]);
const MAIN_PROVIDERS = new Set(["ollama", "cloud"]);
const CLOUD_PROVIDERS = new Set(["openai", "anthropic", "google", "deepseek"]);

function saneStage(v: unknown, fallbackCloud: string): StageSnapshot {
  const s = (v ?? {}) as Partial<StageSnapshot>;
  return {
    provider: STAGE_PROVIDERS.has(s.provider as string) ? (s.provider as StageSnapshot["provider"]) : "inherit",
    model: typeof s.model === "string" ? s.model : "",
    cloudProvider: CLOUD_PROVIDERS.has(s.cloudProvider as string)
      ? (s.cloudProvider as StageSnapshot["cloudProvider"])
      : (CLOUD_PROVIDERS.has(fallbackCloud) ? (fallbackCloud as StageSnapshot["cloudProvider"]) : "openai"),
    cloudModel: typeof s.cloudModel === "string" ? s.cloudModel : "",
  };
}

export function readInference(): InferenceSnapshot {
  try {
    const raw = localStorage.getItem(INFERENCE_KEY);
    if (raw) {
      const p = { ...INFERENCE_DEFAULTS, ...JSON.parse(raw) } as InferenceSnapshot;
      // Coerce corrupt/unknown values (old drafts, hand-edited storage):
      // an unknown provider string would otherwise construct a broken
      // CloudProvider/Ollama selection deep in the pipeline.
      if (!MAIN_PROVIDERS.has(p.provider as string)) p.provider = INFERENCE_DEFAULTS.provider;
      if (!CLOUD_PROVIDERS.has(p.cloudProvider as string)) p.cloudProvider = INFERENCE_DEFAULTS.cloudProvider;
      if (p.embedMode !== "local" && p.embedMode !== "server") p.embedMode = INFERENCE_DEFAULTS.embedMode;
      if (!Number.isFinite(p.numCtx) || p.numCtx <= 0) p.numCtx = INFERENCE_DEFAULTS.numCtx;
      if (!["minimal", "low", "medium", "high", "max"].includes(p.makalahThinkLevel as string)) {
        p.makalahThinkLevel = INFERENCE_DEFAULTS.makalahThinkLevel;
      }
      if (p.summarizeMethod !== "stuff" && p.summarizeMethod !== "map_reduce") p.summarizeMethod = "stuff";
      for (const k of ["mapStage", "reduceStage", "synthesisStage", "makalahOutlineStage", "makalahSectionStage"] as const) {
        p[k] = saneStage(p[k], p.cloudProvider);
      }
      return p;
    }
  } catch {
    /* ignore */
  }
  return { ...INFERENCE_DEFAULTS };
}

export function toSel(extra?: Partial<InferenceSelection>): InferenceSelection {
  const s = readInference();
  return {
    provider: s.provider,
    model: s.model,
    cloudProvider: s.cloudProvider,
    cloudModel: s.cloudModel,
    temperature: s.temperature,
    numCtx: s.numCtx,
    embedMode: s.embedMode,
    thinking: false,
    broad: false,
    hybrid: "off",
    summarizeMethod: s.summarizeMethod ?? "stuff",
    mapStage: s.mapStage ?? { provider: "inherit", model: "", cloudProvider: s.cloudProvider, cloudModel: "" },
    reduceStage: s.reduceStage ?? { provider: "inherit", model: "", cloudProvider: s.cloudProvider, cloudModel: "" },
    synthesisStage: s.synthesisStage ?? { provider: "inherit", model: "", cloudProvider: s.cloudProvider, cloudModel: "" },
    makalahOutlineStage: (s as Partial<InferenceSnapshot>).makalahOutlineStage ?? { provider: "inherit", model: "", cloudProvider: s.cloudProvider, cloudModel: "" },
    makalahSectionStage: (s as Partial<InferenceSnapshot>).makalahSectionStage ?? { provider: "inherit", model: "", cloudProvider: s.cloudProvider, cloudModel: "" },
    makalahThinking: (s as Partial<InferenceSnapshot>).makalahThinking ?? false,
    makalahNumPredict: (s as Partial<InferenceSnapshot>).makalahNumPredict ?? 3072,
    makalahThinkLevel: (s as Partial<InferenceSnapshot>).makalahThinkLevel ?? "low",
    makalahThinkingBudget: (s as Partial<InferenceSnapshot>).makalahThinkingBudget ?? 1024,
    ...extra,
  };
}

function readConfig() {
  const s = readInference();
  return {
    rag_provider: "ollama",
    rag_model: s.model,
    thinking_available: true,
    chat: { model: s.model, num_ctx: s.numCtx, ctx_safety_margin: 800, temperature: s.temperature, num_predict: s.numPredict ?? 2048 },
  };
}

export const settingsApi = {
  config: () => Promise.resolve(readConfig()),
  updateConfig: async (payload: Record<string, string>) => {
    const s = readInference();
    const next = { ...s };
    if (payload.chat_model !== undefined) next.model = payload.chat_model.trim() || INFERENCE_DEFAULTS.model;
    if (payload.chat_num_ctx?.trim()) next.numCtx = Number(payload.chat_num_ctx);
    if (payload.chat_temperature?.trim()) next.temperature = Number(payload.chat_temperature);
    if (payload.chat_num_predict?.trim()) next.numPredict = Number(payload.chat_num_predict);
    try {
      localStorage.setItem(INFERENCE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return Promise.resolve(readConfig());
  },
  settings: async () => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    } catch {
      return {};
    }
  },
  updateSettings: async (body: Record<string, string>) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(body));
    } catch {
      /* ignore */
    }
    return body;
  },
};
