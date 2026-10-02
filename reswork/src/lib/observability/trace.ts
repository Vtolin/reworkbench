// Client-side operation trace (Phase 7).
//
// Lightweight {traceId, step, ms, provider, model, counts} records for RAG
// retrieve, rerank and LLM calls. Deliberately narrow by construction: steps
// carry durations + counts only — there is NO field for prompts, keys, or
// document content, so content can never leak even if a caller is careless.
// Records stay in memory (capped ring) and go NOWHERE by default (the sink
// is a noop until setTraceSink installs one); the dev/debug panel reads the
// local collector. Everything still routes through redact() on export.

import { redact } from "./log";

export interface TraceStep {
  traceId: string;
  step: string;
  ms: number;
  provider?: string;
  model?: string;
  counts?: Record<string, number>;
}

export interface TraceSummary {
  traceId: string;
  steps: TraceStep[];
  totalMs: number;
}

const MAX_TRACES = 20;
const MAX_STEPS_PER_TRACE = 200;

const traces = new Map<string, TraceStep[]>();
let counter = 0;

type TraceSink = (step: TraceStep) => void;
let sink: TraceSink = () => {};

/** Mint a trace id (no node dependency — runs in the browser). Pure. */
export function newTraceId(prefix = "tr"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Install an export sink (default: nowhere). Returns an uninstall fn. */
export function setTraceSink(next: TraceSink | null): () => void {
  sink = next ?? (() => {});
  return () => {
    sink = () => {};
  };
}

/** Record one step (durations + counts only — no content fields exist). */
export function traceStep(step: TraceStep): void {
  const steps = traces.get(step.traceId) ?? [];
  steps.push({ ...step, counts: step.counts ? { ...step.counts } : undefined });
  if (steps.length > MAX_STEPS_PER_TRACE) steps.splice(0, steps.length - MAX_STEPS_PER_TRACE);
  traces.set(step.traceId, steps);
  if (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next();
    if (!oldest.done) traces.delete(oldest.value);
  }
  try {
    sink(step);
  } catch {
    /* sinks never break the operation */
  }
}

/**
 * Time fn as one step. Records ms + fields even on failure (with
 * ok:false count), then rethrows unchanged — observation only.
 */
export async function withTrace<T>(
  traceId: string,
  step: string,
  fields: { provider?: string; model?: string; counts?: Record<string, number> },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    traceStep({ traceId, step, ms: Date.now() - started, ...fields });
    return out;
  } catch (e) {
    traceStep({ traceId, step, ms: Date.now() - started, ...fields, counts: { ...fields.counts, ok: 0 } });
    throw e;
  }
}

/** Recent traces, newest first (dev/debug panel reads this). */
export function listTraces(): TraceSummary[] {
  return [...traces.entries()]
    .map(([traceId, steps]) => ({
      traceId,
      steps: [...steps],
      totalMs: steps.reduce((n, s) => n + s.ms, 0),
    }))
    .reverse();
}

export function clearTraces(): void {
  traces.clear();
}

/** Redacted export for copy/paste debugging (keys/counts only). */
export function exportTrace(traceId: string): TraceStep[] {
  return (traces.get(traceId) ?? []).map((s) => redact(s));
}
