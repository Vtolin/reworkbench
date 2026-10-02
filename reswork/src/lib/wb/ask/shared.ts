// Research engine shared internals: provider routing, sources, chunk reads, JSON helpers.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { createClient } from "@/lib/supabase/client";
import { chunkArray } from "@/lib/async/pool";
import { OllamaProvider } from "@/lib/ai/ollama";
import { CloudProvider } from "@/lib/ai/cloud";
import type { AIProvider } from "@/lib/ai/types";
import type { retrieveContext } from "@/lib/rag/retrieve";
import { DOCUMENT_COLUMNS_SELECT, type HydratedDoc } from "../library";
import type { InferenceSelection, Source, StageSelection } from "./types";

export function pickProvider(sel: InferenceSelection): { provider: AIProvider; model: string } {
  if (sel.provider === "ollama") return { provider: new OllamaProvider(), model: sel.model };
  return { provider: new CloudProvider(sel.cloudProvider), model: sel.cloudModel };
}
const DEFAULT_STAGE: StageSelection = { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" };
function stageLabel(sel: InferenceSelection): string {
  return sel.provider === "ollama" ? `ollama:${sel.model}` : `${sel.cloudProvider}:${sel.cloudModel}`;
}
export function pickStageProvider(
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
export function hybridInstruction(hybrid?: InferenceSelection["hybrid"]): string {
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
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
export function toSources(passages: Awaited<ReturnType<typeof retrieveContext>>["passages"], docs: Map<string, HydratedDoc>): Source[] {
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
export async function loadDocs(ids: string[]): Promise<Map<string, HydratedDoc>> {
  const map = new Map<string, HydratedDoc>();
  if (!ids.length) return map;
  // Chunked `IN (...)` (see IN_CHUNK_SIZE): scope lists stay small today,
  // but this helper must not be the place that breaks when they grow.
  for (const batch of chunkArray([...new Set(ids)])) {
    const { data } = await createClient().from("documents").select(DOCUMENT_COLUMNS_SELECT).in("id", batch);
    for (const r of (data ?? []) as unknown as Array<Record<string, unknown> & { id: string; original_filename: string; title: string }>) {
      map.set(r.id, r as unknown as HydratedDoc);
    }
  }
  return map;
}
export async function docText(docId: string, maxChars: number): Promise<string> {
  const { data } = await createClient()
    .from("document_chunks")
    .select("content, chunk_index")
    .eq("document_id", docId)
    .order("chunk_index")
    .limit(200);
  return ((data ?? []) as Array<{ content: string }>).map((c) => c.content).join("\n\n").slice(0, maxChars);
}

export async function docChunks(docId: string, limit = 500): Promise<Array<{ content: string; chunk_index: number; page: number | null; section: string | null }>> {
  const { data } = await createClient()
    .from("document_chunks")
    .select("content, chunk_index, page, section")
    .eq("document_id", docId)
    .order("chunk_index")
    .limit(limit);
  return ((data ?? []) as Array<{ content: string; chunk_index: number; page: number | null; section: string | null }>);
}
export function extractJsonObject(text: string): Record<string, unknown> | null {
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
