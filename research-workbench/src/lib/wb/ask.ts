// Browser research engine: retrieval (Supabase FTS+pgvector→RRF) + generation
// (member's own Ollama or BYOK cloud). Replaces the FastAPI research routes
// with identical UI-facing shapes: {answer, sources[], thinking?, retrieved?}.
import { createClient } from "@/lib/supabase/client";
import { retrieveContext, type RagOptions } from "@/lib/rag/retrieve";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { AIProvider, ChatMessage } from "@/lib/ai/types";
import { getWorkspaceId, type HydratedDoc } from "./library";

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
    topN: topN * 2,
    embedMode: sel.embedMode,
    scopeIds: opts.scopeIds?.length ? opts.scopeIds : undefined,
  };
  const { passages, context } = await retrieveContext(ragOpts);
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
    const { passages, context } = await retrieveContext({
      workspaceId: ws,
      query,
      topN: topN * 2,
      embedMode: sel.embedMode,
      scopeIds: opts.scopeIds?.length ? opts.scopeIds : undefined,
    });
    const docs = await loadDocs([...new Set(passages.map((p) => p.document_id))]);
    const sources = toSources(passages.slice(0, topN), docs);
    handlers.onMeta?.({ sources, retrieved: { count: passages.length } });
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
        onThinking: (d) => handlers.onThinking?.(d),
      });
      handlers.onDone?.({ answer: result.content, sources, thinking: result.thinking ?? null, retrieved: { count: passages.length } });
    } else {
      const result = await provider.chat(messages, { model, temperature: sel.temperature, signal: opts.signal });
      // Simulate token flow so the streaming UI behaves identically.
      const chunks = result.content.match(/[\s\S]{1,24}/g) ?? [];
      for (const c of chunks) {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        handlers.onStatus?.("generating");
        handlers.onToken?.(c);
        await new Promise((r) => setTimeout(r, 8));
      }
      handlers.onDone?.({ answer: result.content, sources, thinking: null, retrieved: { count: passages.length } });
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

export async function summarize(doc: HydratedDoc, sel: InferenceSelection): Promise<{ summary: string; stats: { method: string; page_count: number; chunk_count: number } }> {
  const { provider, model } = pickProvider(sel);
  const text = await docText(doc.id, 60000);
  const { count } = await createClient().from("document_chunks").select("id", { count: "exact", head: true }).eq("document_id", doc.id);
  const result = await provider.chat(
    [{
      role: "user",
      content: `Summarize the following document (${doc.document_type ?? "general"}). Structure: purpose/method, key findings with verbatim facts (percentages, dates, sample sizes, legal citations), limitations.\n\nDocument: ${doc.title}\n\nText:\n${text || "(no extracted text)"}`,
    }],
    { model, temperature: 0, numCtx: sel.numCtx },
  );
  return {
    summary: result.content,
    stats: { method: "stuff", page_count: doc.page_count ?? 0, chunk_count: count ?? 0 },
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

export async function synthesis(docIds: string[], question: string, sel: InferenceSelection): Promise<{ answer: string; documents: string[] }> {
  const { provider, model } = pickProvider(sel);
  const docs = await loadDocs(docIds);
  const sections: string[] = [];
  for (const id of docIds) {
    const d = docs.get(id);
    const label = d?.title || (d as unknown as { original_filename?: string } | undefined)?.original_filename || `doc ${id.slice(0, 8)}`;
    sections.push(`=== ${label} ===\n${(await docText(id, 8000)) || "(no text available)"}`);
  }
  const context = sections.join("\n\n");
  if (!context.trim()) return { answer: "No document text available for synthesis.", documents: docIds };
  const r = await provider.chat(
    [
      { role: "system", content: SYNTHESIS_SYSTEM },
      { role: "user", content: `Question: ${question}\n\nExcerpts:\n${context}` },
    ],
    { model, temperature: sel.temperature, numCtx: sel.numCtx },
  );
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
