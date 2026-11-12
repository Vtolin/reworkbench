import type { MatrixRow, Source } from "@/lib/wb/ask/types";
import type { HydratedDoc } from "@/lib/wb/library";

/** Research modes share the page shell and conversation store. */
export type Mode = "ask" | "compare" | "summarize" | "matrix" | "synthesis";

/** Hybrid-source knob: how much the model may lean on training data. */
export type HybridMode = "off" | "low" | "medium" | "high" | "maximum";

/** Documents are hydrated library rows; components only read display fields. */
export type ResearchDoc = HydratedDoc;
export type { MatrixRow, Source };

/** Pipeline progress event (retrieve/summarize/synthesis all use this shape). */
export interface PipelineStatus {
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
}

/** Pipeline progress plus the wall-clock start used by elapsed counters. */
export interface TimedStatus extends PipelineStatus {
  since: number;
}

export interface ChatSource {
  citation: string;
  snippet: string;
}
