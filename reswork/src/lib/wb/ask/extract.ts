// Research structured extraction + legal analysis.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { docText, extractJsonObject, pickProvider } from "./shared";
import type { HydratedDoc } from "../library";
import type { InferenceSelection } from "./types";

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
