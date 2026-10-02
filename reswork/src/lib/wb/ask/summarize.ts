// Research summarize: stuff + map_reduce pipelines over document chunks.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { docChunks, pickStageProvider, stripThinkingTags } from "./shared";
import { mapWithLimit } from "@/lib/async/pool";
import { CallBudget } from "@/lib/research/budget";
import type { HydratedDoc } from "../library";
import type { InferenceSelection, PipelineHandlers } from "./types";

// Full mlra 3-stage pipeline: MAP (fast model) extracts tagged bullet
// facts per chunk -> REDUCE (mid model) consolidates across rounds ->
// SYNTHESIS (heavy model) writes the doc-type-aware final narrative.
// A deterministic regex layer appends verbatim facts (percentages,
// dates, sample sizes, Pasal/UU/putusan citations) no LLM can garble.

// Full mlra 3-stage pipeline: MAP (fast model) extracts tagged bullet
// facts per chunk -> REDUCE (mid model) consolidates across rounds ->
// SYNTHESIS (heavy model) writes the doc-type-aware final narrative.
// A deterministic regex layer appends verbatim facts (percentages,
// dates, sample sizes, Pasal/UU/putusan citations) no LLM can garble.
export async function summarize(
  doc: HydratedDoc,
  sel: InferenceSelection,
  handlers: PipelineHandlers = {},
  opts: { budget?: CallBudget } = {},
): Promise<{
  summary: string;
  stats: {
    method: string; page_count: number; chunk_count: number; doc_type?: string;
    map_model?: string; reduce_model?: string; synthesis_model?: string;
    verbatim_fact_count?: number; stage_timings?: Array<[string, number]>; total_seconds?: number;
  };
}> {
  const timings: Array<[string, number]> = [];
  const t0 = Date.now();
  const onStatus = (stage: string, detail?: string, current?: number, total?: number) => {
    timings.push([`${stage}${detail ? `: ${detail}` : ""}`, Math.round(((Date.now() - t0) / 1000) * 10) / 10]);
    handlers.onStatus?.(stage, detail, current, total);
  };
  const {
    countTokens, extractVerbatimFacts, formatVerbatimSection,
    detectStaleSections, batchByBudget, joinLabeled, classifyDocTypeToken,
    DOC_TYPE_SYSTEM_PROMPT, STUFF_SYSTEM_PROMPT, MAP_SYSTEM_PROMPT,
    INTERMEDIATE_REDUCE_SYSTEM_PROMPT, synthesisPromptFor,
    sanitizeModelOutput,
  } = await import("@/lib/research/summarization");

  const rows = await docChunks(doc.id);
  const chunks = rows.map((c) => ({ content: c.content, page: c.page, section: c.section }));
  const method = sel.summarizeMethod ?? "stuff";
  const n = chunks.length;
  const pages = new Set(chunks.map((c) => c.page ?? 0));

  const map = pickStageProvider(sel, sel.mapStage);
  const reduce = pickStageProvider(sel, sel.reduceStage);
  const synth = pickStageProvider(sel, sel.synthesisStage);
  // Stage context caps (mlra budgets), bounded by the user's num_ctx.
  const mapCtx = Math.min(sel.numCtx || 32768, 6144);
  const reduceCtx = Math.min(sel.numCtx || 32768, 12288);
  const reduceBudget = Math.floor((reduceCtx - 800) * 0.6);
  const stuffBudget = Math.floor(((sel.numCtx || 32768) - 800) * 0.6);

  // Per-run call budget (Phase 7): every billed provider.chat goes through
  // check() first; exhaustion throws into the existing error path (visible
  // progress + message, no silent truncation). Billed calls are never retried.
  const budget = opts.budget ?? new CallBudget(CallBudget.summarizeLimit());
  const chat = (
    provider: typeof map.provider, model: string, system: string, user: string, numCtx: number, numPredict?: number,
  ) => {
    budget.check("summarize");
    return provider.chat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      { model, temperature: 0, numCtx, ...(numPredict ? { numPredict } : {}) },
    ).then((r) => stripThinkingTags(r.content));
  };

  // Deterministic verbatim-facts layer (no LLM) — exact figures survive
  // regardless of what the models paraphrase.
  onStatus("preparing", `Extracting verbatim facts (${n} chunks)`, 0, Math.max(n, 1));
  const stale = detectStaleSections(chunks);
  const { facts, tableRowsRemoved } = extractVerbatimFacts(chunks, stale);
  const appendix = formatVerbatimSection(facts, tableRowsRemoved);
  const verbatimCount = Object.values(facts).reduce((a, v) => a + v.length, 0);

  const labeledAll: Array<[string, string]> = chunks.map((c, i) => [
    `[Chunk ${i + 1} | Page ${c.page ?? "?"} | ${c.section || "General Section"}]`,
    c.content,
  ]);
  const fullText = joinLabeled(labeledAll);

  // Doc-type classification rides the cheap map model (mlra DOC_TYPE_MODEL).
  const classify = async (): Promise<string> => {
    onStatus("preparing", `Classifying document type (${map.label})`);
    const snippet = `${doc.title}\n\n${chunks.map((c) => c.content).join("\n\n").slice(0, 4500)}`;
    const raw = await chat(map.provider, map.model, DOC_TYPE_SYSTEM_PROMPT, snippet, Math.min(sel.numCtx || 32768, 4096), 32);
    return classifyDocTypeToken(raw);
  };

  const baseStats = {
    page_count: doc.page_count ?? pages.size ?? 0,
    chunk_count: n,
    map_model: map.label,
    reduce_model: reduce.label,
    synthesis_model: synth.label,
    verbatim_fact_count: verbatimCount,
  };
  const finishTimings = () => ({
    stage_timings: timings,
    total_seconds: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
  });

  if (method !== "map_reduce" || countTokens(fullText) <= stuffBudget) {
    const docType = n ? await classify() : "general";
    onStatus("synthesizing", `Single pass (${synth.label})`);
    const raw = await chat(
      synth.provider, synth.model, STUFF_SYSTEM_PROMPT,
      `[Document Type: ${docType}]\n\nDocument: ${doc.title}\n\n${fullText.slice(0, 60000) || "(no extracted text)"}`,
      sel.numCtx, 5120,
    );
    const summary = sanitizeModelOutput(raw);
    onStatus("done", `${n} chunks`);
    return {
      summary: appendix ? `${summary}\n${appendix}` : summary,
      stats: { ...baseStats, method: method === "map_reduce" ? "map_reduce (stuffed, fits context)" : "stuff", doc_type: docType, ...finishTimings() },
    };
  }

  // ---- Map: per-chunk fact extraction with the map model ----
  // Bounded parallelism (3): order preserved by mapWithLimit, so extracts
  // align with chunks exactly as the old sequential loop. Progress counts
  // completions (was: starts) — same totals, monotonic either way.
  onStatus("preparing", `${n} chunks • map ${map.label} → reduce ${reduce.label} → synthesis ${synth.label}`, 0, n);
  let mapped = 0;
  const extracts = await mapWithLimit(chunks.map((_, i) => i), 3, async (i) => {
    const raw = await chat(
      map.provider, map.model, MAP_SYSTEM_PROMPT,
      `Document: ${doc.title}\n${labeledAll[i][0]}\n${chunks[i].content.slice(0, 6000)}`,
      mapCtx, 2688,
    );
    mapped += 1;
    onStatus("mapping", `Extracting ${mapped}/${n} chunks (${map.label})`, mapped, n);
    return raw.trim().length >= 10 ? raw.trim() : "- No factual claims identified in this section.";
  });

  const docType = await classify();

  // ---- Reduce: recursive consolidation (reduce model), then the
  // ---- synthesis model writes the final doc-type-aware narrative.
  const reduceLoop = async (parts: string[], round = 1, prevTokens: number | null = null): Promise<string> => {
    const labeled: Array<[string, string]> = parts.map((ext, i) => [`[Extract Part ${i + 1}]`, ext]);
    const combined = joinLabeled(labeled);
    const combinedTokens = countTokens(combined);
    const forceRound = parts.length > 8 && round === 1;
    const stagnant = prevTokens !== null && combinedTokens > prevTokens * 0.85;
    if ((combinedTokens <= reduceBudget && !forceRound) || ((round >= 5 || parts.length <= 1 || stagnant) && !forceRound)) {
      onStatus("synthesizing", `Final summary with ${synth.label}`);
      return chat(
        synth.provider, synth.model, synthesisPromptFor(docType),
        `[Document Type: ${docType}]\n\n${combined.slice(0, 40000)}`,
        sel.numCtx, 5120,
      );
    }
    onStatus("reducing", `Combining ${parts.length} extracts, round ${round} (${reduce.label})`);
    const batches = batchByBudget(labeled, reduceBudget);
    const next: string[] = [];
    for (let b = 0; b < batches.length; b++) {
      if (batches.length > 1) onStatus("reducing", `Combining group ${b + 1}/${batches.length}, round ${round} (${reduce.label})`, b + 1, batches.length);
      next.push(await chat(reduce.provider, reduce.model, INTERMEDIATE_REDUCE_SYSTEM_PROMPT, joinLabeled(batches[b]).slice(0, 30000), reduceCtx, 2048));
    }
    return reduceLoop(next, round + 1, combinedTokens);
  };

  const rawSummary = await reduceLoop(extracts);
  const summary = sanitizeModelOutput(rawSummary);
  onStatus("done", `${n} chunks`);
  return {
    summary: appendix ? `${summary}\n${appendix}` : summary,
    stats: { ...baseStats, method: "map_reduce", doc_type: docType, ...finishTimings() },
  };
}
