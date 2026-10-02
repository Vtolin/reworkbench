// Research engine domain types.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import type { ChatMessage } from "../../ai/types";

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
  thinking?: boolean;
  broad?: boolean;
  hybrid?: "off" | "low" | "medium" | "high" | "maximum";
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
  /** Makalah thinking effort level, sent when drafting with thinking on. */
  makalahThinkLevel?: "minimal" | "low" | "medium" | "high" | "max";
  /** Makalah thinking-token budget for drafting (prompt-declared + capped). */
  makalahThinkingBudget?: number;
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
export interface StreamHandlers {
  onMeta?: (data: { sources: Source[]; retrieved: unknown }) => void;
  onStatus?: (stage: string, detail?: string) => void;
  onThinking?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: AskResult) => void;
  onError?: (err: string) => void;
}
export interface PipelineHandlers {
  onStatus?: (stage: string, detail?: string, current?: number, total?: number) => void;
}
export interface MatrixRow {
  paper: string;
  year: number | null;
  method: string;
  dataset: string;
  findings: string;
  limitations: string;
}
