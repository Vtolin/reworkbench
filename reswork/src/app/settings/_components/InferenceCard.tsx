"use client";

import { useState } from "react";
import { useInference } from "@/contexts/InferenceContext";
import { detectOllamaModels } from "@/lib/ollama/detect";
import { Panel, buttonClass, fieldClass } from "@/components/ui/Panel";

/** Chat + cloud BYOK settings. All state is device-local by design. */
export function InferenceCard() {
  const { settings: inf, setSettings: setInf, ollamaModels, refreshOllamaModels, ollamaOnline } = useInference();
  const [cloudKey, setCloudKey] = useState("");
  const [cloudMsg, setCloudMsg] = useState<string | null>(null);
  const [cloudModels, setCloudModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<string[] | null>(null);

  const detect = async () => {
    setDetecting(true);
    try {
      const { models } = await detectOllamaModels();
      setDetected(models);
      await refreshOllamaModels();
    } finally {
      setDetecting(false);
    }
  };

  const readError = async (res: Response, fallback: string): Promise<string> => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? fallback;
  };

  const saveCloudKey = async () => {
    if (!cloudKey) return;
    const res = await fetch("/api/ai/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: inf.cloudProvider, apiKey: cloudKey }),
    });
    if (res.ok) {
      setCloudMsg("Key saved (encrypted at rest, owner-only — never shared). Now press ↻ Models to list.");
      setCloudKey("");
    } else {
      setCloudMsg(await readError(res, "Save failed"));
    }
  };

  const removeCloudKey = async () => {
    if (!confirm("Forget your saved cloud API key on this workspace? (This does not revoke it at the provider — rotate it there too.)")) {
      return;
    }
    const res = await fetch("/api/ai/proxy", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: inf.cloudProvider }),
    });
    if (res.ok) {
      setCloudKey("");
      setCloudModels(null);
      setCloudMsg("Saved key removed from the app. Rotate it in the provider dashboard to fully revoke.");
    } else {
      setCloudMsg(await readError(res, "Remove failed"));
    }
  };

  const fetchCloudModels = async () => {
    setFetchingModels(true);
    try {
      const { listCloudModels } = await import("@/lib/ai/cloud");
      const models = await listCloudModels(inf.cloudProvider);
      setCloudModels(models);
      setCloudMsg(models.length ? null : "No models returned — check the key.");
    } catch (e) {
      setCloudMsg(e instanceof Error ? e.message : "Model list failed (save your key first).");
      setCloudModels(null);
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <Panel
      title="Chat — inference on this device"
      description={
        <>
          Model choice, context length, temperature and keys are <span className="text-white">local/browser state</span> — never
          shared with the workspace. This controls the model used by <span className="font-mono text-white">Research → Ask</span>,
          document Q&amp;A and synthesis. Changes apply on the next question — no restart required.
        </>
      }
    >
      <div className="mt-3 flex flex-wrap gap-2 rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 font-mono text-[11px] text-[#8e8e8e]">
        <span>
          provider <b className="text-white">{inf.provider}</b>
        </span>
        <span className="hidden text-[#2f2f2f] sm:inline">•</span>
        <span>
          model <b className="text-white">{inf.provider === "ollama" ? inf.model : inf.cloudModel}</b>
        </span>
        <span className="hidden text-[#2f2f2f] sm:inline">•</span>
        <span>
          num_ctx <b className="text-white">{inf.numCtx}</b>
        </span>
        <span className="hidden text-[#2f2f2f] sm:inline">•</span>
        <span>
          temperature <b className="text-white">{inf.temperature}</b>
        </span>
        <span className="hidden text-[#2f2f2f] sm:inline">•</span>
        <span>
          ollama <b className="text-white">{ollamaOnline ? `online (${ollamaModels.length} models)` : "offline"}</b>
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="text-xs font-medium text-[#ececec]">
          Provider
          <select
            value={inf.provider}
            onChange={(e) => setInf({ provider: e.target.value as "ollama" | "cloud" })}
            className={fieldClass}
          >
            <option value="ollama">Ollama (local, private)</option>
            <option value="cloud">Cloud (my own key)</option>
          </select>
          <span className="text-[11px] text-[#5f5f5f]">Local = zero server-side inference. Cloud = proxied with your personal key.</span>
        </label>
        <label className="text-xs font-medium text-[#ececec]">
          Ollama model tag
          <input
            value={inf.model}
            onChange={(e) => setInf({ model: e.target.value })}
            list="ollama-models"
            placeholder="gemma4:26b-a4b-it-qat"
            className={fieldClass}
          />
          <datalist id="ollama-models">
            {ollamaModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="text-[11px] text-[#5f5f5f]">
            Must be pulled: <span className="font-mono">ollama pull gemma4:26b-a4b-it-qat</span>.
          </span>
        </label>
        <label className="text-xs font-medium text-[#ececec]">
          Context length — num_ctx
          <input
            type="number"
            value={inf.numCtx}
            onChange={(e) => setInf({ numCtx: Number(e.target.value) })}
            placeholder="32768"
            min={4096}
            max={131072}
            step={1024}
            className={fieldClass}
          />
          <span className="text-[11px] text-[#5f5f5f]">Per-request KV cache. Lower (e.g. 8192) if you hit OOM on big models.</span>
        </label>
        <label className="text-xs font-medium text-[#ececec]">
          Temperature (0–2)
          <input
            type="number"
            value={inf.temperature}
            onChange={(e) => setInf({ temperature: Number(e.target.value) })}
            placeholder="0.0"
            min={0}
            max={2}
            step={0.1}
            className={fieldClass}
          />
          <span className="text-[11px] text-[#5f5f5f]">0 = deterministic. 0.7–1.0 for more creative hypotheses.</span>
        </label>
        <label className="text-xs font-medium text-[#ececec]">
          Embedding mode
          <select
            value={inf.embedMode}
            onChange={(e) => setInf({ embedMode: e.target.value as "local" | "server" })}
            className={fieldClass}
          >
            <option value="local">Local (Ollama nomic-embed-text, private)</option>
            <option value="server">Server (cloud embedding API, my key)</option>
          </select>
          <span className="text-[11px] text-[#5f5f5f]">Used for uploads and query embeddings on this device.</span>
        </label>
        <div className="text-xs font-medium text-[#ececec]">
          Installed models
          <div className="mt-1">
            <button onClick={detect} disabled={detecting} className={buttonClass}>
              {detecting ? "Detecting…" : "Auto-detect Ollama models"}
            </button>
            {detected ? (
              <div className="mt-1 break-all text-[11px] text-[#8e8e8e]">
                {detected.join(", ") || "none found — is 'ollama serve' running?"}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-[#2f2f2f] pt-4 text-xs font-medium text-[#ececec]">
        Cloud provider (BYOK — personal, never shared)
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={inf.cloudProvider}
            onChange={(e) => {
              setInf({ cloudProvider: e.target.value as "openai" | "anthropic" | "google" | "deepseek" });
              setCloudModels(null);
            }}
            className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          >
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="google">Google</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input
            value={inf.cloudModel}
            onChange={(e) => setInf({ cloudModel: e.target.value })}
            list="cloud-models"
            placeholder={`Model (${{
              openai: "e.g. gpt-4o-mini",
              deepseek: "e.g. deepseek-chat",
              google: "e.g. gemini-2.5-flash",
              anthropic: "e.g. claude-haiku-4-5",
            }[inf.cloudProvider]})`}
            className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
          <datalist id="cloud-models">
            {(cloudModels ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button onClick={fetchCloudModels} disabled={fetchingModels} className={buttonClass} title="List models from the provider using your saved key">
            {fetchingModels ? "…" : "↻ Models"}
          </button>
          <input
            value={cloudKey}
            onChange={(e) => setCloudKey(e.target.value)}
            type="password"
            placeholder="Paste API key (encrypted server-side)"
            className="min-w-64 flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
          <button onClick={saveCloudKey} className={buttonClass}>
            Save key
          </button>
          <button onClick={removeCloudKey} className="rounded-xl border border-red-900/50 bg-[#171717] px-4 py-2 text-sm text-red-400 hover:bg-red-950/30">
            Remove key
          </button>
        </div>
        {cloudModels ? (
          <div className="mt-1 break-all text-[11px] text-[#8e8e8e]">
            {cloudModels.length ? `${cloudModels.length} models from provider` : "No models returned"}
          </div>
        ) : null}
        {cloudMsg ? <div className="mt-2 text-[11px] text-[#8e8e8e]">{cloudMsg}</div> : null}
        <div className="mt-1 text-[11px] text-[#5f5f5f]">
          Effective: model {inf.model} • ctx {inf.numCtx} • temp {inf.temperature}
        </div>
      </div>
    </Panel>
  );
}
