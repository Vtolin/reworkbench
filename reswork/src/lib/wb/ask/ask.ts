// Research ask: single + streaming generation over hybrid retrieval.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { retrieveContext, type RagOptions } from "@/lib/rag/retrieve";
import { OllamaProvider } from "@/lib/ai/ollama";
import type { AIProvider, ChatMessage } from "@/lib/ai/types";
import { newTraceId, withTrace } from "@/lib/observability/trace";
import { getWorkspaceId } from "../library";
import { hybridInstruction, loadDocs, pickProvider, stripThinkingTags, toSources } from "./shared";
import { fetchFilteredWebSources, type WebContextBundle } from "./webSearchBridge";
import type { AskResult, InferenceSelection, StreamHandlers } from "./types";

function buildAskPrompt(
  query: string,
  sel: InferenceSelection,
  libraryContext: string,
  web: WebContextBundle,
): string {
  const sections: string[] = [hybridInstruction(sel.hybrid)];
  sections.push(`Excerpts:\n${libraryContext || "(no library excerpts retrieved)"}`);
  if (web.promptBlock) {
    sections.push(
      `Live Web Sources (anti-slop filtered; cite as [W1], [W2] with source domain):\n${web.promptBlock}`,
    );
  }
  sections.push(`Question: ${query}`);
  return sections.join("\n\n");
}

export async function ask(
  query: string,
  sel: InferenceSelection,
  opts: { scopeIds?: string[]; sessionLabel?: string } = {},
): Promise<AskResult> {
  const ws = await getWorkspaceId();
  const { provider, model } = pickProvider(sel);
  const traceId = newTraceId("ask"); // Phase 7: retrieve + llm steps share this id.
  const topN = sel.broad ? 12 : 8;
  const ragOpts: RagOptions = {
    workspaceId: ws,
    query,
    topN,
    embedMode: sel.embedMode,
    scopeIds: opts.scopeIds?.length ? opts.scopeIds : undefined,
    rerankProvider: provider,
    rerankModel: model,
    traceId,
  };
  const { passages, context, debug } = await retrieveContext(ragOpts);
  const webBundle = sel.webSearch
    ? await fetchFilteredWebSources(query, sel)
    : { sources: [], promptBlock: "", count: 0, filteredOutCount: 0 };
  if (!passages.length && !webBundle.count && sel.hybrid === "off") {
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
        "Approve/re-upload in the Library, then ask again - or switch Hybrid on to let the model answer from its own knowledge." +
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
  const libSources = toSources(passages.slice(0, topN), docs);
  const sources = [...libSources, ...webBundle.sources];
  const contextText = libSources.length
    ? passages.slice(0, topN).map((p, i) => `[${i + 1}] ${p.content}`).join("\n\n")
    : context;

  const history = sel.memoryMessages?.slice(-6) ?? [];
  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: buildAskPrompt(query, sel, contextText, webBundle),
    },
  ];
  const result = await withTrace(
    traceId,
    "llm.chat",
    { provider: provider.id, model, counts: { messages: messages.length } },
    () =>
      provider.chat(messages, {
        model,
        temperature: sel.temperature,
        numCtx: sel.numCtx,
        thinking: sel.provider === "ollama" ? sel.thinking : false,
      } as Parameters<AIProvider["chat"]>[1]),
  );
  // Toggle off = no Thinking box, ever. Reasoning-distilled models emit
  // <think> tags spontaneously, so strip them instead of surfacing a box.
  if (!sel.thinking) {
    return { answer: stripThinkingTags(result.content), sources, thinking: null, retrieved: { count: passages.length } };
  }
  return { answer: result.content, sources, thinking: result.thinking ?? null, retrieved: { count: passages.length } };
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
    const traceId = newTraceId("ask"); // Phase 7: retrieve + llm steps share this id.
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
      traceId,
    });
    const docs = await loadDocs([...new Set(passages.map((p) => p.document_id))]);
    const libSources = toSources(passages.slice(0, topN), docs);
    let webBundle: WebContextBundle = { sources: [], promptBlock: "", count: 0, filteredOutCount: 0 };
    if (sel.webSearch) {
      handlers.onStatus?.("searching_web", sel.webSearchProvider);
      webBundle = await fetchFilteredWebSources(query, sel, opts.signal);
    }
    const sources = [...libSources, ...webBundle.sources];
    handlers.onMeta?.({ sources, retrieved: { count: passages.length, webCount: webBundle.count, debug } });
    if (!passages.length && !webBundle.count && sel.hybrid === "off") {
      handlers.onDone?.({
        answer:
          "I couldn't find anything in the approved library for that. Usually this means one of: " +
          "the documents are still awaiting admin approval, the uploads contain no extractable text " +
          "(scanned PDFs need OCR before re-uploading), or nothing has been embedded yet. " +
          "Approve/re-upload in the Library, then ask again - or switch Hybrid on to let the model answer from its own knowledge." +
          `\n\n_Diagnostics: ${debug.embedError ? `embedding: ${debug.embedError} · ` : ""}retrieval: FTS ${debug.ftsCount}, vector ${debug.vectorCount}, BM25 ${debug.bm25Count} (embedMode ${debug.embedMode}${debug.embeddingDims ? `, ${debug.embeddingDims}d` : ""})_`,
        sources: [],
        thinking: null,
        retrieved: { count: 0, debug },
      });
      return;
    }
    handlers.onStatus?.(sel.provider === "ollama" && sel.thinking ? "processing_prompt" : "generating");

    const history = sel.memoryMessages?.slice(-6) ?? [];
    const contextText = libSources.length
      ? passages.slice(0, topN).map((p, i) => `[${i + 1}] ${p.content}`).join("\n\n")
      : context;
    const messages: ChatMessage[] = [
      ...history,
      {
        role: "user",
        content: buildAskPrompt(query, sel, contextText, webBundle),
      },
    ];
    if (sel.provider === "ollama") {
      const result = await withTrace(
        traceId,
        "llm.chat",
        { provider: provider.id, model, counts: { messages: messages.length } },
        () =>
          (provider as OllamaProvider).chat(messages, {
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
          }),
      );
      if (!sel.thinking) {
        handlers.onDone?.({ answer: stripThinkingTags(result.content), sources, thinking: null, retrieved: { count: passages.length } });
      } else {
        handlers.onDone?.({ answer: result.content, sources, thinking: result.thinking ?? null, retrieved: { count: passages.length } });
      }
    } else {
      const result = await withTrace(
        traceId,
        "llm.chat",
        { provider: provider.id, model, counts: { messages: messages.length } },
        () => provider.chat(messages, { model, temperature: sel.temperature, signal: opts.signal }),
      );
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
