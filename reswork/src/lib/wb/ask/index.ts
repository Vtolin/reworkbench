// Browser research engine: retrieval (Supabase FTS+pgvector→RRF) + generation
// (member's own Ollama or BYOK cloud). Replaces the FastAPI research routes
// with identical UI-facing shapes: {answer, sources[], thinking?, retrieved?}.
//
// Phase 9: implementation split into cohesive use-case modules; this barrel
// preserves the exact public surface previously provided by lib/wb/ask.ts so
// all existing importers keep working unchanged.

export type {
  StageSelection,
  InferenceSelection,
  Source,
  AskResult,
  StreamHandlers,
  PipelineHandlers,
  MatrixRow,
} from "./types";

export { ask, askStream } from "./ask";
export { compare } from "./compare";
export { summarize } from "./summarize";
export { literatureMatrix } from "./matrix";
export { synthesis } from "./synthesis";
export { structuredExtract, legalAnalysis } from "./extract";

// Canonical home of extractJsonArray (deduplicated Phase 9: the identical
// copy in lib/research/analysis.ts was dead code with zero importers).
export { extractJsonArray } from "./shared";
