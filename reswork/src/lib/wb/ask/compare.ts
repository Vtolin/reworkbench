// Research compare: per-document retrieval with per-source answers.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { retrieveContext } from "@/lib/rag/retrieve";
import { getWorkspaceId } from "../library";
import { loadDocs, pickProvider, toSources } from "./shared";
import type { InferenceSelection, Source } from "./types";

export async function compare(query: string, docIds: string[], sel: InferenceSelection): Promise<{ answer: string; sources: Record<string, Source[]> }> {
  const ws = await getWorkspaceId();
  const { provider, model } = pickProvider(sel);
  const docs = await loadDocs(docIds);
  const labeled: string[] = [];
  const sources: Record<string, Source[]> = {};
  for (const id of docIds) {
    const d = docs.get(id);
    const label = d?.original_filename || d?.title || id.slice(0, 8);
    const { passages } = await retrieveContext({ workspaceId: ws, query, topN: 6, embedMode: sel.embedMode, scopeIds: [id] });
    const excerpt = passages.map((p) => p.content).join("\n\n") || "(no relevant excerpts)";
    labeled.push(`=== Source: ${label} ===\n${excerpt.slice(0, 8000)}`);
    sources[label] = toSources(passages.slice(0, 6), docs);
  }
  const result = await provider.chat(
    [{ role: "user", content: `Compare the sources below on: ${query}\nLabel every claim per-source. Flag "no relevant excerpts" when a source lacks evidence.\n\n${labeled.join("\n\n")}` }],
    { model, temperature: sel.temperature, numCtx: sel.numCtx },
  );
  return { answer: result.content, sources };
}
