// Research literature matrix: per-document STRICT-JSON extraction.
// Extracted verbatim from lib/wb/ask.ts (Phase 9); behavior unchanged.
import { docText, extractJsonObject, pickProvider } from "./shared";
import type { HydratedDoc } from "../library";
import type { InferenceSelection, MatrixRow } from "./types";

const MATRIX_SYSTEM =
  "You are a meticulous research analyst. Extract the requested fields from the provided document text into STRICT JSON with keys: method, dataset, findings, limitations, year. Every value is a string; use 'n/a' when the text does not state it. Do not invent anything. Reply with ONLY the JSON object.";
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
