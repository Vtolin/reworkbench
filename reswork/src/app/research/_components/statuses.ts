import type { PipelineStatus } from "./types";

/** Pipeline stage → human label. One map for every progress surface. */
export const STATUS_LABELS: Record<string, string> = {
  starting: "Starting…",
  retrieving: "Searching documents…",
  searching_web: "Searching the web…",
  reranking: "Reranking results…",
  preparing: "Preparing context…",
  processing_prompt: "Processing prompt…",
  classifying: "Classifying document…",
  mapping: "Extracting chunks…",
  reducing: "Combining summaries…",
  synthesizing: "Synthesizing final summary…",
  exporting: "Exporting report…",
  generating: "Generating…",
  working: "Working…",
};

/**
 * Label a status event, appending the detail (or a progress count such as
 * "chunk 3/12") when the pipeline supplies one.
 */
export function statusLabel(status: PipelineStatus, progressNoun?: string): string {
  const base = STATUS_LABELS[status.stage] ?? status.stage;
  if (status.detail) return `${base} - ${status.detail}`;
  if (progressNoun && status.current != null && status.total != null) {
    return `${base} - ${progressNoun} ${status.current}/${status.total}`;
  }
  return base;
}
