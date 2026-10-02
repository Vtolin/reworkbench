// Port of core/research/analysis.py prompt shapes (browser-orchestrated).
// The LLM call itself goes through the selected AIProvider; these builders
// assemble deterministic prompts + parse STRICT-JSON outputs.

export function literatureMatrixPrompt(docs: Array<{ label: string; excerpt: string }>): string {
  const labeled = docs
    .map((d) => `=== ${d.label} ===\n${d.excerpt.slice(0, 28000)}`)
    .join("\n\n");
  return `Extract one JSON array row per document below. STRICT JSON only, no prose.
Schema per row: {"paper": string, "year": number|null, "method": string, "dataset": string, "findings": string, "limitations": string}

${labeled}`;
}

export function synthesisPrompt(question: string, docs: Array<{ label: string; excerpt: string }>): string {
  const labeled = docs
    .map((d) => `=== Source: ${d.label} ===\n${d.excerpt.slice(0, 8000)}`)
    .join("\n\n");
  return `Synthesize across sources. Sections: Agreement / Disagreement / Research gaps / Claims by support.
Per-source attribution required; never average conflicts. Question: ${question}

${labeled}`;
}

export function comparePrompt(question: string, docs: Array<{ label: string; excerpt: string }>): string {
  const labeled = docs
    .map((d) => `=== Source: ${d.label} ===\n${d.excerpt.slice(0, 8000)}`)
    .join("\n\n");
  return `Compare the sources below on: ${question}\nLabel every claim per-source. Flag "no relevant excerpts" when a source lacks evidence.\n\n${labeled}`;
}

// NOTE (Phase 9): extractJsonArray used to be duplicated here and in
// lib/wb/ask.ts (byte-identical, zero callers of either copy). The canonical
// home is lib/wb/ask/shared.ts, re-exported by lib/wb/ask; this copy is
// removed so there is one source of truth.
