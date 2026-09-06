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

export function extractJsonArray<T>(text: string): T[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in model output");
  return JSON.parse(fenced.slice(start, end + 1)) as T[];
}
