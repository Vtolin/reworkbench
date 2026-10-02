// Local inference settings: LOCAL/BROWSER STATE ONLY. Never shared workspace
// data. Only {provider, model} may be recorded in message metadata_json for
// reproducibility — the server never manages the model itself.
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { CloudProviderId } from "@/lib/ai/cloud";
import type { StageSnapshot } from "@/lib/api/inference";
import { useLocalStorageDoc } from "./localStorage";

export type InferenceProvider = "ollama" | "cloud";

// Canonical CloudProviderId lives in lib/ai/cloud (Phase 11); re-exported
// here so existing UI importers keep working.
export type { CloudProviderId };

export interface InferenceSettings {
  provider: InferenceProvider;
  model: string;
  embedMode: "local" | "server";
  temperature: number;
  numCtx: number;
  cloudProvider: CloudProviderId;
  cloudModel: string;
  /** Summarization pipeline: single-pass stuff vs per-chunk map→reduce. */
  summarizeMethod: "stuff" | "map_reduce";
  /** Per-stage model overrides for the summarization/synthesis pipeline.
   *  provider "inherit" = use the main chat provider+model above. */
  mapStage: StageModel;
  reduceStage: StageModel;
  synthesisStage: StageModel;
  /** Makalah pipeline overrides (inherit = use main chat provider+model). */
  makalahOutlineStage: StageModel;
  makalahSectionStage: StageModel;
  /** Makalah chain-of-thought. Off (default) = deterministic JSON output. */
  makalahThinking: boolean;
  /** Makalah per-call output cap (num_predict). */
  makalahNumPredict: number;
  /** Makalah thinking effort level (Ollama low/medium/high/max; minimal = Gemini 3 closest-to-off). */
  makalahThinkLevel: "minimal" | "low" | "medium" | "high" | "max";
  /** Makalah thinking-token budget for section drafting. */
  makalahThinkingBudget: number;
}

export type StageProvider = "inherit" | "ollama" | "cloud";

// Canonical stage shape lives in lib/api/inference (Phase 11): identical
// fields, one source of truth. Local alias keeps UI imports stable.
export type StageModel = StageSnapshot;

const INHERIT_STAGE: StageModel = {
  provider: "inherit",
  model: "",
  cloudProvider: "openai",
  cloudModel: "",
};

const DEFAULTS: InferenceSettings = {
  provider: "ollama",
  model: "gemma4:26b-a4b-it-qat",
  embedMode: "local",
  temperature: 0.0,
  numCtx: 32768,
  cloudProvider: "openai",
  cloudModel: "gpt-4o-mini",
  summarizeMethod: "stuff",
  mapStage: { ...INHERIT_STAGE },
  reduceStage: { ...INHERIT_STAGE },
  synthesisStage: { ...INHERIT_STAGE },
  makalahOutlineStage: { ...INHERIT_STAGE },
  makalahSectionStage: { ...INHERIT_STAGE },
  makalahThinking: false,
  makalahNumPredict: 3072,
  makalahThinkLevel: "low",
  makalahThinkingBudget: 1024,
};

const STORAGE_KEY = "rw.inference_settings.v1";

/**
 * Corrupt-storage sanitizer (domain rule, kept verbatim): merge over
 * defaults, then coerce every selective field back into range — a corrupt
 * stored string must never construct a broken provider selection downstream.
 * Pure (unit-tested); same coercion as api.readInference (canonical).
 */
export function sanitizeInferenceSettings(raw: unknown, defaults: InferenceSettings): InferenceSettings {
  const p = { ...defaults, ...(raw as Partial<InferenceSettings>) };
  if (p.provider !== "ollama" && p.provider !== "cloud") p.provider = defaults.provider;
  if (!["openai", "anthropic", "google", "deepseek"].includes(p.cloudProvider)) p.cloudProvider = defaults.cloudProvider;
  if (!["minimal", "low", "medium", "high", "max"].includes(p.makalahThinkLevel as string)) {
    p.makalahThinkLevel = defaults.makalahThinkLevel;
  }
  if (p.embedMode !== "local" && p.embedMode !== "server") p.embedMode = defaults.embedMode;
  if (!Number.isFinite(p.numCtx) || (p.numCtx as number) <= 0) p.numCtx = defaults.numCtx;
  return p;
}

const Ctx = createContext<{
  settings: InferenceSettings;
  setSettings: (patch: Partial<InferenceSettings>) => void;
  ollamaModels: string[];
  refreshOllamaModels: () => Promise<void>;
  ollamaOnline: boolean;
  /** Non-null when settings stopped persisting (quota/private mode). */
  persistError: string | null;
}>({
  settings: DEFAULTS,
  setSettings: () => {},
  ollamaModels: [],
  refreshOllamaModels: async () => {},
  ollamaOnline: false,
  persistError: null,
});

export function useInference() {
  return useContext(Ctx);
}

export function InferenceProvider({ children }: { children: ReactNode }) {
  // Hydrate/persist via the shared hook (Phase 6): write-through timing and
  // sanitization identical to the inline code replaced. persistError is
  // exposed (triple surface) but still unrendered, as before.
  const {
    value: settings,
    setValue: setState,
    persistError,
  } = useLocalStorageDoc<InferenceSettings>({
    key: STORAGE_KEY,
    defaults: DEFAULTS,
    sanitize: sanitizeInferenceSettings,
    messages: {
      quotaMessage: "Browser storage is full — inference settings are kept only in this tab's memory.",
      failureMessage: "Settings autosave failed — inference settings are kept only in this tab's memory.",
    },
  });
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState(false);

  const setSettings = (patch: Partial<InferenceSettings>) => {
    setState((prev) => ({ ...prev, ...patch }));
  };

  const refreshOllamaModels = async () => {
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      if (!res.ok) throw new Error("offline");
      const data = await res.json();
      setOllamaModels((data.models ?? []).map((m: { name: string }) => m.name));
      setOllamaOnline(true);
    } catch {
      setOllamaOnline(false);
      setOllamaModels([]);
    }
  };

  useEffect(() => {
    refreshOllamaModels();
  }, []);

  return (
    <Ctx.Provider value={{ settings, setSettings, ollamaModels, refreshOllamaModels, ollamaOnline, persistError }}>
      {children}
    </Ctx.Provider>
  );
}
