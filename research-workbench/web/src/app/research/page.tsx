"use client";

import { useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { useInference } from "@/contexts/InferenceContext";
import { retrieveContext } from "@/lib/rag/retrieve";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import { InferenceSettingsPanel } from "@/components/InferenceSettings";

export default function ResearchPage() {
  const { workspace, user } = useSession();
  const { settings } = useInference();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [passages, setPassages] = useState<Array<{ content: string; document_id: string; page: number | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    if (!workspace || !query.trim()) return;
    setBusy(true);
    setError(null);
    setAnswer("");
    try {
      // 1. Retrieved context from Supabase (FTS + pgvector → RRF).
      const { passages: ps, context } = await retrieveContext({
        workspaceId: workspace.id,
        query,
        topN: 8,
        embedMode: settings.embedMode,
      });
      setPassages(ps);
      // 2. Generation via the member's OWN provider (local Ollama or BYOK cloud).
      const system = `Answer from the excerpts below with citations like [1], [2]. If the excerpts lack the answer, say so.`;
      const prompt = `${system}\n\nExcerpts:\n${context}\n\nQuestion: ${query}`;
      const provider =
        settings.provider === "ollama"
          ? new OllamaProvider()
          : new CloudProvider(settings.cloudProvider);
      const model = settings.provider === "ollama" ? settings.model : settings.cloudModel;
      const result = await provider.chat(
        [{ role: "user", content: prompt }],
        { model, temperature: settings.temperature, numCtx: settings.numCtx },
      );
      setAnswer(result.content);
      // 3. Best-effort: persist the Q&A to the research trail (shared, visibility only).
      void fetch("/api/research/trail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          event_type: "query",
          payload: { query, model: `${result.provider}:${result.model}`, user: user?.id },
        }),
      }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Research failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-100">Research</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Postgres FTS + pgvector → fusion/RRF → your own model.
      </p>
      <div className="mt-4 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Ask the shared library…"
          className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
        />
        <button
          onClick={ask}
          disabled={busy}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {answer && (
        <div className="mt-6 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-sm font-medium text-neutral-300">Answer</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-100">{answer}</p>
        </div>
      )}
      {passages.length > 0 && (
        <div className="mt-4 space-y-2">
          <h2 className="text-sm font-medium text-neutral-300">Sources ({passages.length})</h2>
          {passages.map((p, i) => (
            <details key={i} className="rounded border border-neutral-800 p-3 text-sm">
              <summary className="cursor-pointer text-neutral-200">
                [{i + 1}] doc {p.document_id.slice(0, 8)}{p.page ? ` · Page ${p.page}` : ""}
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-neutral-400">{p.content.slice(0, 1200)}</p>
            </details>
          ))}
        </div>
      )}
      <div className="mt-10">
        <InferenceSettingsPanel />
      </div>
    </main>
  );
}
