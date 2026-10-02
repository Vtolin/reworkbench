// Feature API: ask / research (compare, summarize, matrix, synthesis,
// extract, legal analysis, trail). Extracted verbatim from lib/api.ts
// (Phase 5); behavior unchanged.
import {
  ask as wbAsk, askStream as wbAskStream, compare as wbCompare,
  summarize as wbSummarize, literatureMatrix, synthesis as wbSynthesis,
  structuredExtract, legalAnalysis as wbLegalAnalysis,
  type InferenceSelection, type StreamHandlers,
} from "../wb/ask";
import { getDocument, getWorkspaceId, type HydratedDoc } from "../wb/library";
import { recordQuery } from "../wb/projects";
import { toSel } from "./inference";

export interface AskBody {
  query: string;
  document_ids?: string[];
  broad?: boolean;
  thinking?: boolean;
  use_memory?: boolean;
  hybrid_mode?: string;
  session_id?: string;
  project_id?: string | null;
  memoryMessages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

function modelLabel(sel: InferenceSelection): string {
  return `${sel.provider === "ollama" ? "ollama" : sel.cloudProvider}:${sel.provider === "ollama" ? sel.model : sel.cloudModel}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const researchApi = {
  ask: async (body: AskBody) => {
    const sel = toSel({
      broad: body.broad,
      thinking: body.thinking,
      hybrid: (body.hybrid_mode as InferenceSelection["hybrid"]) ?? "off",
      memoryMessages: body.use_memory === false ? [] : body.memoryMessages,
    });
    const r = await wbAsk(body.query, sel, { scopeIds: body.document_ids });
    if (body.project_id) {
      await recordQuery({
        projectId: body.project_id,
        query: body.query,
        answer: r.answer,
        sources: r.sources,
        modelUsed: modelLabel(sel),
      }).catch(() => {});
    }
    return r;
  },
  askStream: (
    body: AskBody,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ) => {
    const sel = toSel({
      broad: body.broad,
      thinking: body.thinking,
      hybrid: (body.hybrid_mode as InferenceSelection["hybrid"]) ?? "off",
      memoryMessages: body.use_memory === false ? [] : body.memoryMessages,
    });
    return wbAskStream(body.query, sel, {
      ...handlers,
      onDone: (data) => {
        if (body.project_id) {
          recordQuery({
            projectId: body.project_id,
            query: body.query,
            answer: data.answer,
            sources: data.sources,
            modelUsed: modelLabel(sel),
          }).catch(() => {});
        }
        handlers.onDone?.(data);
      },
    }, { scopeIds: body.document_ids, signal });
  },
  clearMemory: async () => ({ ok: true }),
  memoryStatus: async () => ({ enabled: true, turns: 0 }),

  compare: async (body: { query: string; document_ids: string[] }) => wbCompare(body.query, body.document_ids, toSel()),
  summarize: async (body: { document_id: string; onStatus?: (stage: string, detail?: string, current?: number, total?: number) => void }) => {
    const doc = await getDocument(body.document_id);
    return wbSummarize(doc, toSel(), body.onStatus ? { onStatus: body.onStatus } : undefined);
  },
  summarizeStream: async (
    body: { document_id: string },
    handlers: { onStatus?: (stage: string, detail?: string, current?: number, total?: number) => void; onDone?: (data: { summary: string; stats: unknown }) => void; onError?: (err: string) => void },
  ) => {
    try {
      handlers.onStatus?.("preparing");
      const doc = await getDocument(body.document_id);
      const r = await wbSummarize(doc, toSel(), {
        onStatus: (stage, detail, current, total) => handlers.onStatus?.(stage, detail, current, total),
      });
      handlers.onDone?.({ summary: r.summary, stats: r.stats });
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : "Summarize failed");
    }
  },
  summarizeExport: async (document_id: string, format: string): Promise<Blob> => {
    const doc = await getDocument(document_id);
    const r = await wbSummarize(doc, toSel());
    const title = doc.original_filename || doc.title || "summary";
    if (format === "html") {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — summary</title></head><body style="font-family:sans-serif;max-width:70ch;margin:2rem auto;line-height:1.6"><h1>${escapeHtml(title)}</h1><pre style="white-space:pre-wrap">${escapeHtml(r.summary)}</pre></body></html>`;
      return new Blob([html], { type: "text/html" });
    }
    // PDF: render the same summary into a print window (user saves as PDF).
    const w = window.open("", "_blank");
    if (!w) throw new Error("Popup blocked — allow popups to export PDF");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — summary</title></head><body style="font-family:sans-serif;max-width:70ch;margin:2rem auto;line-height:1.6"><h1>${escapeHtml(title)}</h1><pre style="white-space:pre-wrap">${escapeHtml(r.summary)}</pre></body></html>`);
    w.document.close();
    w.focus();
    w.print();
    return new Blob([r.summary], { type: "text/plain" });
  },
  matrix: async (document_ids: string[]) => {
    const docs: HydratedDoc[] = [];
    for (const id of document_ids) docs.push(await getDocument(id));
    return { rows: await literatureMatrix(docs, toSel()) };
  },
  matrixExport: async (rows: Array<Record<string, unknown>>, format: string) => {
    const fmt = format.toLowerCase();
    if (fmt === "md") {
      const cols = ["paper", "year", "method", "dataset", "findings", "limitations"];
      const head = `| ${cols.map((c) => c[0].toUpperCase() + c.slice(1)).join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`).join("\n");
      return { markdown: [head, sep, body].join("\n") };
    }
    if (fmt === "xlsx") {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Matrix");
      const buf: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    const cols = ["paper", "year", "method", "dataset", "findings", "limitations"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  },
  synthesis: (document_ids: string[], question: string, handlers?: { onStatus?: (stage: string, detail?: string, current?: number, total?: number) => void }) => wbSynthesis(document_ids, question, toSel(), handlers ? { onStatus: handlers.onStatus } : undefined),
};

// Tail of the research section: in the original facade order these follow
// the makalah block, so they spread separately in the barrel (see lib/api.ts).
export const researchTailApi = {
  extract: async (document_id: string, schema: string) => {
    const doc = await getDocument(document_id);
    return structuredExtract(doc, schema, toSel());
  },
  legalAnalysis: async (document_id: string) => {
    const doc = await getDocument(document_id);
    return wbLegalAnalysis(doc, toSel());
  },
  trail: async () => {
    const ws = await getWorkspaceId();
    const res = await fetch(`/api/research/trail?workspaceId=${ws}&limit=100`);
    if (!res.ok) throw new Error("Trail unavailable");
    return res.json();
  },
};
