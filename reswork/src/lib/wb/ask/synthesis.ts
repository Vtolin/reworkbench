// Research synthesis: agreement/disagreement/gaps across documents.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { docText, loadDocs, pickStageProvider } from "./shared";
import type { InferenceSelection, PipelineHandlers } from "./types";

const SYNTHESIS_SYSTEM =
  "You are a rigorous research analyst comparing multiple documents. Answer the question using ONLY the labeled excerpts. Structure the answer with these sections (markdown): **Agreement**, **Disagreement**, **Research gaps**, **Claims by support** (list claims and which sources support them). Attribute every claim to its source by name. If sources conflict, say so explicitly - never average them into one position.";

export async function synthesis(
  docIds: string[],
  question: string,
  sel: InferenceSelection,
  handlers: PipelineHandlers = {},
): Promise<{ answer: string; documents: string[] }> {
  const onStatus = handlers.onStatus ?? (() => {});
  const stage = pickStageProvider(sel, sel.synthesisStage);
  const docs = await loadDocs(docIds);
  const sections: string[] = [];
  for (let i = 0; i < docIds.length; i++) {
    const id = docIds[i];
    onStatus("preparing", `Loading excerpt ${i + 1}/${docIds.length}`, i + 1, docIds.length);
    const d = docs.get(id);
    const label = d?.title || (d as unknown as { original_filename?: string } | undefined)?.original_filename || `doc ${id.slice(0, 8)}`;
    sections.push(`=== ${label} ===\n${(await docText(id, 8000)) || "(no text available)"}`);
  }
  const context = sections.join("\n\n");
  if (!context.trim()) return { answer: "No document text available for synthesis.", documents: docIds };
  onStatus("synthesizing", `Synthesizing ${docIds.length} sources (${stage.label})`);
  const r = await stage.provider.chat(
    [
      { role: "system", content: SYNTHESIS_SYSTEM },
      { role: "user", content: `Question: ${question}\n\nExcerpts:\n${context}` },
    ],
    { model: stage.model, temperature: sel.temperature, numCtx: sel.numCtx },
  );
  onStatus("done", `${docIds.length} sources`);
  return { answer: r.content, documents: docIds };
}
