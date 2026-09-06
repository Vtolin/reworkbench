"use client";

import { useState } from "react";
import { useInference } from "@/contexts/InferenceContext";
import { detectOllamaModels } from "@/lib/ollama/detect";

// Inference settings UI — LOCAL/BROWSER STATE ONLY (localStorage).
// Model choice, temperature, context length, and keys are never shared.
export function InferenceSettingsPanel() {
  const { settings, setSettings, ollamaModels, refreshOllamaModels, ollamaOnline } = useInference();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<string[] | null>(null);

  const detect = async () => {
    setDetecting(true);
    const { models } = await detectOllamaModels();
    setDetected(models);
    await refreshOllamaModels();
    setDetecting(false);
  };

  const saveKey = async () => {
    if (!key) return;
    const res = await fetch("/api/ai/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: settings.cloudProvider, apiKey: key }),
    });
    if (res.ok) {
      setKeySaved(true);
      setKey("");
    }
  };

  return (
    <section className="rounded border border-neutral-800 p-4">
      <h2 className="font-medium text-neutral-100">Inference settings (this device only)</h2>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <label className="space-y-1 text-neutral-300">
          <span>Provider</span>
          <select
            value={settings.provider}
            onChange={(e) => setSettings({ provider: e.target.value as "ollama" | "cloud" })}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="ollama">Ollama (local)</option>
            <option value="cloud">Cloud (my own key)</option>
          </select>
        </label>
        <label className="space-y-1 text-neutral-300">
          <span>Embedding mode</span>
          <select
            value={settings.embedMode}
            onChange={(e) => setSettings({ embedMode: e.target.value as "local" | "server" })}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="local">Local (Ollama, private)</option>
            <option value="server">Server (cloud embedding API)</option>
          </select>
        </label>
        <label className="space-y-1 text-neutral-300">
          <span>Ollama model {ollamaOnline ? `(${ollamaModels.length} installed)` : "(offline)"}</span>
          <input
            value={settings.model}
            onChange={(e) => setSettings({ model: e.target.value })}
            list="ollama-models"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
          <datalist id="ollama-models">
            {ollamaModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="space-y-1 text-neutral-300">
          <span>Temperature ({settings.temperature})</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={settings.temperature}
            onChange={(e) => setSettings({ temperature: Number(e.target.value) })}
            className="w-full"
          />
        </label>
        <label className="space-y-1 text-neutral-300">
          <span>Context length (num_ctx)</span>
          <input
            type="number"
            min={4096}
            max={131072}
            value={settings.numCtx}
            onChange={(e) => setSettings({ numCtx: Number(e.target.value) })}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
        </label>
        <div className="space-y-1 text-neutral-300">
          <span>Installed models</span>
          <div>
            <button onClick={detect} disabled={detecting} className="rounded border border-neutral-700 px-3 py-1">
              {detecting ? "Detecting…" : "Auto-detect Ollama models"}
            </button>
            {detected && <p className="mt-1 text-xs text-neutral-400">{detected.join(", ") || "none found"}</p>}
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-neutral-800 pt-3 text-sm">
        <h3 className="font-medium text-neutral-200">Cloud provider (BYOK — personal, never shared)</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={settings.cloudProvider}
            onChange={(e) =>
              setSettings({ cloudProvider: e.target.value as "openai" | "anthropic" | "google" })
            }
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
          </select>
          <input
            value={settings.cloudModel}
            onChange={(e) => setSettings({ cloudModel: e.target.value })}
            placeholder="Model (e.g. gpt-4o-mini)"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            placeholder="Paste API key (encrypted server-side)"
            className="min-w-64 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
          <button onClick={saveKey} className="rounded border border-neutral-700 px-3 py-1">
            Save key
          </button>
        </div>
        {keySaved && <p className="mt-1 text-xs text-emerald-400">Key saved (encrypted at rest, owner-only).</p>}
      </div>
    </section>
  );
}
