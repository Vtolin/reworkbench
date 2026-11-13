"use client";

import { useEffect, useState } from "react";
import { useInference } from "@/contexts/InferenceContext";
import { Panel, buttonClass, fieldClass } from "@/components/ui/Panel";
import {
  WEB_SEARCH_PROVIDER_LABELS,
  type WebFilterMode,
  type WebSearchProviderId,
} from "@/lib/search/webFilter";

const PROVIDER_HINTS: Record<WebSearchProviderId, { placeholder: string; note: string }> = {
  ollama_web: {
    placeholder: "Paste Ollama API key (ollama.com)",
    note: "Uses Ollama's hosted Web Search API (generous free tier; works with both local Ollama and cloud LLMs).",
  },
  google_web: {
    placeholder: "AIza... (Gemini Grounding) or cx:AIza... (Custom Search)",
    note: "Accepts either a Google Gemini API key (Google Search Grounding) or Search Engine ID + Key as cx:AIza...",
  },
  tavily: {
    placeholder: "tvly-...",
    note: "Research-focused web search API tuned for RAG snippets.",
  },
  brave: {
    placeholder: "BSA...",
    note: "Independent Brave Search web index API key (X-Subscription-Token).",
  },
};

/** Optional BYOK Web Search configuration + Anti-AI-Slop filtering. */
export function WebSearchCard() {
  const { settings: inf, setSettings: setInf } = useInference();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const syncConfigured = async () => {
    try {
      const res = await fetch("/api/search/web");
      if (!res.ok) return;
      const data = (await res.json()) as { configuredProviders?: WebSearchProviderId[] };
      if (Array.isArray(data.configuredProviders)) {
        setInf({ webSearchConfiguredProviders: data.configuredProviders });
      }
    } catch {
      /* offline */
    }
  };

  useEffect(() => {
    let active = true;
    fetch("/api/search/web")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { configuredProviders?: WebSearchProviderId[] } | null) => {
        if (!active || !data?.configuredProviders) return;
        setInf({ webSearchConfiguredProviders: data.configuredProviders });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configured = inf.webSearchConfiguredProviders.includes(inf.webSearchProvider);
  const hint = PROVIDER_HINTS[inf.webSearchProvider];

  const saveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setMsg("Paste a Web Search API key first.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/search/web", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: inf.webSearchProvider, apiKey: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(body.error || "Could not save web search key.");
        return;
      }
      setApiKey("");
      await syncConfigured();
      setMsg(`Saved ${WEB_SEARCH_PROVIDER_LABELS[inf.webSearchProvider]} key. Web toggle unlocked in Research.`);
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/search/web", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: inf.webSearchProvider }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(body.error || "Could not remove web search key.");
        return;
      }
      await syncConfigured();
      setMsg(`Removed ${WEB_SEARCH_PROVIDER_LABELS[inf.webSearchProvider]} key.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Web Search - optional BYOK + Anti-AI-Slop filter"
      description={
        <>
          Optionally connect a Web Search API key so <span className="font-mono text-white">Research → Ask</span> models
          (local Ollama or cloud) can retrieve live web sources. The <span className="font-mono text-white">Web</span>{" "}
          toggle in Research stays disabled until a key is saved for the active provider. Results are scrubbed against
          content farms and AI-slop boilerplate, while prioritizing academic and legal domains.
        </>
      }
    >
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 font-medium ${
            configured ? "text-emerald-400" : "text-[#8e8e8e]"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${configured ? "bg-emerald-400" : "bg-[#5f5f5f]"}`} />
          {configured
            ? `${WEB_SEARCH_PROVIDER_LABELS[inf.webSearchProvider]} key configured - Web toggle enabled in Research`
            : `No key saved for ${WEB_SEARCH_PROVIDER_LABELS[inf.webSearchProvider]} - Web toggle locked in Research`}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="text-xs font-medium text-[#ececec]">
          Web Search Provider
          <select
            value={inf.webSearchProvider}
            onChange={(e) => {
              setMsg(null);
              setInf({ webSearchProvider: e.target.value as WebSearchProviderId });
            }}
            className={fieldClass}
          >
            <option value="ollama_web">Ollama Web Search (ollama.com free tier)</option>
            <option value="google_web">Google Search (Gemini Grounding / Custom Search)</option>
            <option value="tavily">Tavily AI Search</option>
            <option value="brave">Brave Web Search</option>
          </select>
          <span className="mt-1 block text-[11px] font-normal text-[#7a7a7a]">{hint.note}</span>
        </label>

        <label className="text-xs font-medium text-[#ececec]">
          Anti-AI-Slop Source Filter
          <select
            value={inf.webSearchFilterMode}
            onChange={(e) => setInf({ webSearchFilterMode: e.target.value as WebFilterMode })}
            className={fieldClass}
          >
            <option value="balanced">Balanced (block slop farms, boost .edu/.ac/.gov)</option>
            <option value="strict_academic">Strict Academic &amp; Official (.edu/.ac/.gov/doi/arxiv only)</option>
          </select>
          <span className="mt-1 block text-[11px] font-normal text-[#7a7a7a]">
            Blocks Quora, homework mills, scraper mirrors, and AI filler phrases before injecting web snippets.
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-medium text-[#ececec]">
          {WEB_SEARCH_PROVIDER_LABELS[inf.webSearchProvider]} API Key (encrypted at rest)
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hint.placeholder}
            className={fieldClass}
            autoComplete="off"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={saveKey}
            disabled={busy || !apiKey.trim()}
            className={`${buttonClass} border-white bg-white text-black hover:bg-[#ececec] disabled:opacity-40`}
          >
            Save Web Key
          </button>
          {configured ? (
            <button
              type="button"
              onClick={removeKey}
              disabled={busy}
              className={`${buttonClass} border-[#2f2f2f] bg-[#181818] text-[#ececec] hover:border-red-500/60 hover:text-red-300`}
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>

      {msg ? <p className="mt-2 text-xs text-[#b4b4b4]">{msg}</p> : null}
    </Panel>
  );
}
