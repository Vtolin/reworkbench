// Browser research engine: retrieval (Supabase FTS+pgvector→RRF) + generation
// (member's own Ollama or BYOK cloud). Replaces the FastAPI research routes
// with identical UI-facing shapes: {answer, sources[], thinking?, retrieved?}.
import { createClient } from "@/lib/supabase/client";
import { retrieveContext, type RagOptions } from "@/lib/rag/retrieve";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { AIProvider, ChatMessage } from "@/lib/ai/types";
import { getWorkspaceId, type HydratedDoc } from "./library";

export interface StageSelection {
  provider: "inherit" | "ollama" | "cloud";
  model: string;
  cloudProvider: "openai" | "anthropic" | "google" | "deepseek";
  cloudModel: string;
}

export interface InferenceSelection {
  provider: "ollama" | "cloud";
  model: string;
  cloudProvider: "openai" | "anthropic" | "google" | "deepseek";
  cloudModel: string;
  temperature: number;
  numCtx: number;
  embedMode: "local" | "server";
  thinking: boolean;
  broad: boolean;
  hybrid: "off" | "low" | "medium" | "high" | "maximum";
  memoryMessages?: ChatMessage[];
  summarizeMethod?: "stuff" | "map_reduce";
  mapStage?: StageSelection;
  reduceStage?: StageSelection;
  synthesisStage?: StageSelection;
  /** Makalah pipeline overrides: outline (cheap) vs section drafting (heavy). */
  makalahOutlineStage?: StageSelection;
  makalahSectionStage?: StageSelection;
  /** Makalah chain-of-thought toggle (default off = deterministic JSON). */
  makalahThinking?: boolean;
  /** Makalah per-call output cap (num_predict). */
  makalahNumPredict?: number;
}

export interface Source {
  citation: string;
  snippet: string;
  document_id: string;
  page: number | null;
  section: string | null;
}

export interface AskResult {
  answer: string;
  sources: Source[];
  thinking: string | null;
  retrieved: unknown;
}

function pickProvider(sel: InferenceSelection): { provider: AIProvider; model: string } {
  if (sel.provider === "ollama") return { provider: new OllamaProvider(), model: sel.model };
  return { provider: new CloudProvider(sel.cloudProvider), model: sel.cloudModel };
}

const DEFAULT_STAGE: StageSelection = { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" };

function stageLabel(sel: InferenceSelection): string {
  return sel.provider === "ollama" ? `ollama:${sel.model}` : `${sel.cloudProvider}:${sel.cloudModel}`;
}

/** Resolve the provider+model for one pipeline stage (map / reduce / synthesis).
 *  "inherit" (or an empty override) falls back to the main chat selection. */
function pickStageProvider(
  sel: InferenceSelection,
  stage: StageSelection | undefined,
): { provider: AIProvider; model: string; label: string } {
  const s = stage ?? DEFAULT_STAGE;
  if (s.provider === "ollama") {
    const model = s.model.trim() || sel.model;
    return { provider: new OllamaProvider(), model, label: `ollama:${model}` };
  }
  if (s.provider === "cloud") {
    const cp = s.cloudProvider || sel.cloudProvider;
    const model = s.cloudModel.trim() || sel.cloudModel;
    return { provider: new CloudProvider(cp), model, label: `${cp}:${model}` };
  }
  return { ...pickProvider(sel), label: stageLabel(sel) };
}

function hybridInstruction(hybrid: InferenceSelection["hybrid"]): string {
  switch (hybrid) {
    case "low":
      return "Ground every claim in the excerpts; you may sparingly (20%) use training knowledge to connect ideas, labeled as such.";
    case "medium":
      return "Use the excerpts and your training knowledge about equally (50/50); label which claims come from excerpts vs training data.";
    case "high":
      return "You may rely mostly (80%) on your training knowledge, using excerpts as anchors; label excerpt-backed claims.";
    case "maximum":
      return "Answer primarily from your training knowledge; excerpts (if any) are secondary.";
    default:
      return "Answer ONLY from the excerpts below. If they lack the answer, say so explicitly.";
  }
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function toSources(passages: Awaited<ReturnType<typeof retrieveContext>>["passages"], docs: Map<string, HydratedDoc>): Source[] {
  return passages.map((p, i) => {
    const d = docs.get(p.document_id);
    const title = d?.original_filename || d?.title || p.document_id.slice(0, 8);
    const loc = [p.page ? `Page ${p.page}` : null, p.section].filter(Boolean).join(", ");
    return {
      citation: `[${i + 1}] ${title}${loc ? ` — ${loc}` : ""}`,
      snippet: p.content.slice(0, 600),
      document_id: p.document_id,
      page: p.page,
      section: p.section,
    };
  });
}

async function loadDocs(ids: string[]): Promise<Map<string, HydratedDoc>> {
  const map = new Map<string, HydratedDoc>();
  if (!ids.length) return map;
  const { data } = await createClient().from("documents").select("*").in("id", ids);
  for (const r of (data ?? []) as Array<Record<string, unknown> & { id: string; original_filename: string; title: string }>) {
    map.set(r.id, r as unknown as HydratedDoc);
  }
  return map;
}

export async function ask(
  query: string,
  sel: InferenceSelection,
  opts: { scopeIds?: string[]; sessionLabel?: string } = {},
): Promise<AskResult> {
  const ws = await getWorkspaceId();
  const { provider, model } = pickProvider(sel);
  const topN = sel.broad ? 12 : 8;
  const ragOpts: RagOptions = {
    workspaceId: ws,
    query,
    topN,
    embedMode: sel.embedMode,
    scopeIds: opts.scopeIds?.length ? opts.scopeIds : undefined,
    rerankProvider: provider,
    rerankModel: model,
  };
  const { passages, context, debug } = await retrieveContext(ragOpts);
  if (!passages.length && sel.hybrid === "off") {
    // Strict grounding with nothing retrieved: say so plainly (and usefully)
    // instead of spending a model call to echo the constraint back.
    // Include the retrieval reason so cloud+local-embed misconfig is visible
    // instead of hidden behind the generic message.
    const hints: string[] = [];
    if (debug.embedError) hints.push(`embedding: ${debug.embedError}`);
    else if (!debug.hasQueryEmbedding) hints.push("embedding: no query vector (FTS/BM25-only)");
    hints.push(`retrieval: FTS ${debug.ftsCount}, vector ${debug.vectorCount}, BM25 ${debug.bm25Count} (embedMode ${debug.embedMode}${debug.embeddingDims ? `, ${debug.embeddingDims}d` : ""})`);
    return {
      answer:
        "I couldn't find anything in the approved library for that. Usually this means one of: " +
        "the documents are still awaiting admin approval, the uploads contain no extractable text " +
        "(scanned PDFs need OCR before re-uploading), or nothing has been embedded yet. " +
        "Approve/re-upload in the Library, then ask again — or switch Hybrid on to let the model answer from its own knowledge." +
        `\n\n_Diagnostics: ${hints.join(" · ")}_` +
        (debug.embedMode === "local" && debug.embedError
          ? "\n_Local embed failed: is `nomic-embed-text` pulled (`ollama list`), is Ollama reachable from this browser (OLLAMA_ORIGINS for vercel.app), and were uploads embedded with Local mode (768d)?_"
          : "") +
        (debug.embedMode === "server" && !debug.hasQueryEmbedding
          ? "\n_Server embed failed: it requires an OpenAI key saved in Settings (other providers have no embedding endpoint) and docs embedded with the same mode._"
          : ""),
      sources: [],
      thinking: null,
      retrieved: { count: 0, debug },
    };
  }
  const docs = await loadDocs([...new Set(passages.map((p) => p.document_id))]);
  const sources = toSources(passages.slice(0, topN), docs);
  const contextText = sources.length
    ? passages.slice(0, topN).map((p, i) => `[${i + 1}] ${p.content}`).join("\n\n")
    : context;

  const history = sel.memoryMessages?.slice(-6) ?? [];
  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: `${hybridInstruction(sel.hybrid)}\n\nExcerpts:\n${contextText || "(no excerpts retrieved)"}\n\nQuestion: ${query}`,
    },
  ];
  const result = await provider.chat(messages, {
    model,
    temperature: sel.temperature,
    numCtx: sel.numCtx,
    thinking: sel.provider === "ollama" ? sel.thinking : false,
  } as Parameters<AIProvider["chat"]>[1]);
  // Toggle off = no Thinking box, ever. Reasoning-distilled models emit
  // <think> tags spontaneously, so strip them instead of surfacing a box.
  if (!sel.thinking) {
    return { answer: stripThinkingTags(result.content), sources, thinking: null, retrieved: { count: passages.length } };
  }
  return { answer: result.content, sources, thinking: result.thinking ?? null, retrieved: { count: passages.length } };
}

export interface StreamHandlers {
  onMeta?: (data: { sources: Source[]; retrieved: unknown }) => void;
  onStatus?: (stage: string, detail?: string) => void;
  onThinking?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: AskResult) => void;
  onError?: (err: string) => void;
}

// Streaming ask with the same event contract the old SSE endpoint had
// (meta → status → thinking/token → done), so the Research UI is unchanged.
export async function askStream(
  query: string,
  sel: InferenceSelection,
  handlers: StreamHandlers,
  opts: { scopeIds?: string[]; signal?: AbortSignal } = {},
): Promise<void> {
  try {
    handlers.onStatus?.("retrieving");
    const ws = await getWorkspaceId();
    const { provider, model } = pickProvider(sel);
    const topN = sel.broad ? 12 : 8;
    const { passages, context, debug } = await retrieveContext({
      workspaceId: ws,
      query,
      topN,
      embedMode: sel.embedMode,
      scopeIds: opts.scopeIds?.length ? opts.scopeIds : undefined,
      onStatus: (stage, detail) => handlers.onStatus?.(stage, detail),
      rerankProvider: provider,
      rerankModel: model,
    });
    const docs = await loadDocs([...new Set(passages.map((p) => p.document_id))]);
    const sources = toSources(passages.slice(0, topN), docs);
    handlers.onMeta?.({ sources, retrieved: { count: passages.length, debug } });
    if (!passages.length && sel.hybrid === "off") {
      handlers.onDone?.({
        answer:
          "I couldn't find anything in the approved library for that. Usually this means one of: " +
          "the documents are still awaiting admin approval, the uploads contain no extractable text " +
          "(scanned PDFs need OCR before re-uploading), or nothing has been embedded yet. " +
          "Approve/re-upload in the Library, then ask again — or switch Hybrid on to let the model answer from its own knowledge." +
          `\n\n_Diagnostics: ${debug.embedError ? `embedding: ${debug.embedError} · ` : ""}retrieval: FTS ${debug.ftsCount}, vector ${debug.vectorCount}, BM25 ${debug.bm25Count} (embedMode ${debug.embedMode}${debug.embeddingDims ? `, ${debug.embeddingDims}d` : ""})_`,
        sources: [],
        thinking: null,
        retrieved: { count: 0, debug },
      });
      return;
    }
    handlers.onStatus?.(sel.provider === "ollama" && sel.thinking ? "processing_prompt" : "generating");

    const history = sel.memoryMessages?.slice(-6) ?? [];
    const contextText = sources.length
      ? passages.slice(0, topN).map((p, i) => `[${i + 1}] ${p.content}`).join("\n\n")
      : context;
    const messages: ChatMessage[] = [
      ...history,
      {
        role: "user",
        content: `${hybridInstruction(sel.hybrid)}\n\nExcerpts:\n${contextText || "(no excerpts retrieved)"}\n\nQuestion: ${query}`,
      },
    ];
    if (sel.provider === "ollama") {
      const result = await (provider as OllamaProvider).chat(messages, {
        model,
        temperature: sel.temperature,
        numCtx: sel.numCtx,
        thinking: sel.thinking,
        signal: opts.signal,
        onToken: (t) => {
          handlers.onStatus?.("generating");
          handlers.onToken?.(t);
        },
        // Provider already gates thinking deltas on the flag; belt-and-braces
        // here so a spontaneous think stream never opens the box when off.
        onThinking: (d) => { if (sel.thinking) handlers.onThinking?.(d); },
      });
      if (!sel.thinking) {
        handlers.onDone?.({ answer: stripThinkingTags(result.content), sources, thinking: null, retrieved: { count: passages.length } });
      } else {
        handlers.onDone?.({ answer: result.content, sources, thinking: result.thinking ?? null, retrieved: { count: passages.length } });
      }
    } else {
      const result = await provider.chat(messages, { model, temperature: sel.temperature, signal: opts.signal });
      const answer = sel.thinking ? result.content : stripThinkingTags(result.content);
      // Simulate token flow so the streaming UI behaves identically.
      const chunks = answer.match(/[\s\S]{1,24}/g) ?? [];
      for (const c of chunks) {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        handlers.onStatus?.("generating");
        handlers.onToken?.(c);
        await new Promise((r) => setTimeout(r, 8));
      }
      handlers.onDone?.({ answer, sources, thinking: null, retrieved: { count: passages.length } });
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    handlers.onError?.(e instanceof Error ? e.message : "Ask failed");
  }
}

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

async function docText(docId: string, maxChars: number): Promise<string> {
  const { data } = await createClient()
    .from("document_chunks")
    .select("content, chunk_index")
    .eq("document_id", docId)
    .order("chunk_index")
    .limit(200);
  return ((data ?? []) as Array<{ content: string }>).map((c) => c.content).join("\n\n").slice(0, maxChars);
}

async function docChunks(docId: string, limit = 500): Promise<Array<{ content: string; chunk_index: number; page: number | null; section: string | null }>> {
  const { data } = await createClient()
    .from("document_chunks")
    .select("content, chunk_index, page, section")
    .eq("document_id", docId)
    .order("chunk_index")
    .limit(limit);
  return ((data ?? []) as Array<{ content: string; chunk_index: number; page: number | null; section: string | null }>);
}

export interface PipelineHandlers {
  onStatus?: (stage: string, detail?: string, current?: number, total?: number) => void;
}

// Full mlra 3-stage pipeline: MAP (fast model) extracts tagged bullet
// facts per chunk -> REDUCE (mid model) consolidates across rounds ->
// SYNTHESIS (heavy model) writes the doc-type-aware final narrative.
// A deterministic regex layer appends verbatim facts (percentages,
// dates, sample sizes, Pasal/UU/putusan citations) no LLM can garble.
export async function summarize(
  doc: HydratedDoc,
  sel: InferenceSelection,
  handlers: PipelineHandlers = {},
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

  const chat = (
    provider: typeof map.provider, model: string, system: string, user: string, numCtx: number, numPredict?: number,
  ) =>
    provider.chat(
      [{ role: "system", content: system }, { role: "user", content: user }],
      { model, temperature: 0, numCtx, ...(numPredict ? { numPredict } : {}) },
    ).then((r) => stripThinkingTags(r.content));

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
  onStatus("preparing", `${n} chunks • map ${map.label} → reduce ${reduce.label} → synthesis ${synth.label}`, 0, n);
  const extracts: string[] = [];
  for (let i = 0; i < n; i++) {
    onStatus("mapping", `Extracting ${i + 1}/${n} chunks (${map.label})`, i + 1, n);
    const raw = await chat(
      map.provider, map.model, MAP_SYSTEM_PROMPT,
      `Document: ${doc.title}\n${labeledAll[i][0]}\n${chunks[i].content.slice(0, 6000)}`,
      mapCtx, 2688,
    );
    extracts.push(raw.trim().length >= 10 ? raw.trim() : "- No factual claims identified in this section.");
  }

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

export interface MatrixRow {
  paper: string;
  year: number | null;
  method: string;
  dataset: string;
  findings: string;
  limitations: string;
}

const MATRIX_SYSTEM =
  "You are a meticulous research analyst. Extract the requested fields from the provided document text into STRICT JSON with keys: method, dataset, findings, limitations, year. Every value is a string; use 'n/a' when the text does not state it. Do not invent anything. Reply with ONLY the JSON object.";

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const m = cleaned.match(/\{.*\}/s);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export function extractJsonArray<T>(text: string): T[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in model output");
  return JSON.parse(fenced.slice(start, end + 1)) as T[];
}

export async function literatureMatrix(docs: HydratedDoc[], sel: InferenceSelection): Promise<MatrixRow[]> {
  const { provider, model } = pickProvider(sel);
  const rows: MatrixRow[] = [];
  for (const doc of docs) {
    const row: MatrixRow = {
      paper: doc.title || doc.original_filename || "Untitled",
      year: doc.year,
      method: "",
      dataset: "",
      findings: "",
      limitations: "",
    };
    const text = await docText(doc.id, 30000);
    if (text) {
      try {
        const r = await provider.chat(
          [
            { role: "system", content: MATRIX_SYSTEM },
            { role: "user", content: `Document: ${row.paper}\n\nText:\n${text.slice(0, 28000)}` },
          ],
          { model, temperature: 0, numCtx: sel.numCtx, numPredict: 1024 },
        );
        const parsed = extractJsonObject(r.content);
        if (parsed) {
          for (const k of ["method", "dataset", "findings", "limitations", "year"] as const) {
            const v = parsed[k];
            if (v != null && String(v).trim()) row[k] = (k === "year" ? Number(v) || row[k] : String(v).trim()) as never;
          }
        }
      } catch {
        /* keep empty row */
      }
    }
    rows.push(row);
  }
  return rows;
}

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

const EXTRACT_SYSTEM =
  "You are an expert academic/legal analyst. Extract the requested fields from the provided document text into STRICT JSON. Values are strings; use 'n/a' when the text does not state it. Never invent content. For Indonesian legal documents (putusan), preserve Pasal/ayat and statute citations exactly. Reply with ONLY the JSON object.";

const SCHEMAS: Record<string, string[]> = {
  paper: ["methodology", "research_question", "dataset", "findings", "limitations", "contributions", "key_citations", "future_work"],
  legal: ["facts", "issues", "legal_basis", "arguments", "considerations", "ratio_decidendi", "obiter_dictum", "holding"],
};

export async function structuredExtract(doc: HydratedDoc, schema: string, sel: InferenceSelection): Promise<Record<string, string>> {
  const { provider, model } = pickProvider(sel);
  const fields = SCHEMAS[schema] ?? SCHEMAS.paper;
  const text = await docText(doc.id, 60000);
  const result: Record<string, string> = { schema, title: doc.title || doc.original_filename };
  if (!text) {
    for (const f of fields) result[f] = "n/a";
    return result;
  }
  const r = await provider.chat(
    [
      { role: "system", content: `${schema === "legal" ? LEGAL_ANALYSIS_SYSTEM : EXTRACT_SYSTEM} The JSON keys must be exactly: ${fields.join(", ")}.` },
      { role: "user", content: `Document: ${doc.title}\n\nText:\n${text.slice(0, 50000)}` },
    ],
    { model, temperature: 0, numCtx: sel.numCtx, numPredict: 2048 },
  );
  const parsed = extractJsonObject(r.content) ?? {};
  for (const f of fields) result[f] = String(parsed[f] ?? "n/a");
  return result;
}

const LEGAL_ANALYSIS_SYSTEM =
  "You are an expert in Indonesian constitutional and civil law analysis. Analyze the provided court decision (putusan) into STRICT JSON with keys: facts, issues, legal_basis, arguments, considerations, ratio_decidendi, obiter_dictum, holding. Values are strings in markdown; preserve Pasal/ayat and statute citations exactly. Use 'n/a' for missing parts. Reply with ONLY the JSON object.";

export async function legalAnalysis(doc: HydratedDoc, sel: InferenceSelection): Promise<Record<string, string>> {
  return structuredExtract(doc, "legal", { ...sel });
}
