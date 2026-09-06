// Local inference settings: LOCAL/BROWSER STATE ONLY. Never shared workspace
// data. Only {provider, model} may be recorded in message metadata_json for
// reproducibility — the server never manages the model itself.
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type InferenceProvider = "ollama" | "cloud";

export interface InferenceSettings {
  provider: InferenceProvider;
  model: string;
  embedMode: "local" | "server";
  temperature: number;
  numCtx: number;
  cloudProvider: "openai" | "anthropic" | "google";
  cloudModel: string;
}

const DEFAULTS: InferenceSettings = {
  provider: "ollama",
  model: "gemma4:26b-a4b-it-qat",
  embedMode: "local",
  temperature: 0.0,
  numCtx: 32768,
  cloudProvider: "openai",
  cloudModel: "gpt-4o-mini",
};

const STORAGE_KEY = "rw.inference_settings.v1";

const Ctx = createContext<{
  settings: InferenceSettings;
  setSettings: (patch: Partial<InferenceSettings>) => void;
  ollamaModels: string[];
  refreshOllamaModels: () => Promise<void>;
  ollamaOnline: boolean;
}>({
  settings: DEFAULTS,
  setSettings: () => {},
  ollamaModels: [],
  refreshOllamaModels: async () => {},
  ollamaOnline: false,
});

export function useInference() {
  return useContext(Ctx);
}

export function InferenceProvider({ children }: { children: ReactNode }) {
  const [settings, setState] = useState<InferenceSettings>(DEFAULTS);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaOnline, setOllamaOnline] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      /* keep defaults */
    }
  }, []);

  const setSettings = (patch: Partial<InferenceSettings>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
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
    <Ctx.Provider value={{ settings, setSettings, ollamaModels, refreshOllamaModels, ollamaOnline }}>
      {children}
    </Ctx.Provider>
  );
}
