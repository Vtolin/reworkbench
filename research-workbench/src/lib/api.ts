// Browser API facade: the SAME method names the original UI calls
// (api.listDocuments, api.ask, api.compare, …), re-implemented against
// Supabase + browser-side inference. No FastAPI, no localhost server.
// Pages keep their exact UI; only id types changed (number → string uuid).
import { createClient } from "@/lib/supabase/client";
import {
  listDocuments, getDocument, updateDocument, deleteDocument,
  setDocCollections, setDocTags, listCollections, createCollection,
  listTags, createTag, libraryStats, chunkCount, documentFileUrl,
  getWorkspaceId, type HydratedDoc,
} from "./wb/library";
import { groupedSearch, listSavedSearches, createSavedSearch, deleteSavedSearch } from "./wb/search";
import {
  ask as wbAsk, askStream as wbAskStream, compare as wbCompare,
  summarize as wbSummarize, literatureMatrix, synthesis as wbSynthesis,
  structuredExtract, legalAnalysis as wbLegalAnalysis,
  type InferenceSelection, type StreamHandlers,
} from "./wb/ask";
import {
  listProjects, createProject as wbCreateProject, getProject as wbGetProject,
  deleteProject as wbDeleteProject, addEvidence, projectClaims as wbProjectClaims,
  createClaim as wbCreateClaim, deleteClaim as wbDeleteClaim,
  claimAddCitation as wbClaimAddCitation, recordQuery,
} from "./wb/projects";
import {
  relatedDocuments, documentReferences, listAnnotations, createAnnotation as wbCreateAnnotation,
  legalRefresh as wbLegalRefresh, citedCases as wbCitedCases,
} from "./wb/related";
import {
  docToCslItem, renderCitation, renderBibliography, bibtexEntry, risEntry,
  plainCitation, listStyles, setDefaultStyle, fetchStyleFromRepo, saveCustomStyle,
} from "./citations/csl";
import { parseReferences, type ImportRecord } from "./importing/parsers";
import { checkDuplicates } from "./ingestion/dedup";

const INFERENCE_KEY = "rw.inference_settings.v1";
const SETTINGS_KEY = "rw.settings.v1";

export interface InferenceSnapshot {
  provider: "ollama" | "cloud";
  model: string;
  embedMode: "local" | "server";
  temperature: number;
  numCtx: number;
  numPredict?: number;
  cloudProvider: "openai" | "anthropic" | "google";
  cloudModel: string;
}

const INFERENCE_DEFAULTS: InferenceSnapshot = {
  provider: "ollama",
  model: "gemma4:26b-a4b-it-qat",
  embedMode: "local",
  temperature: 0.0,
  numCtx: 32768,
  cloudProvider: "openai",
  cloudModel: "gpt-4o-mini",
};

export function readInference(): InferenceSnapshot {
  try {
    const raw = localStorage.getItem(INFERENCE_KEY);
    if (raw) return { ...INFERENCE_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...INFERENCE_DEFAULTS };
}

function toSel(extra?: Partial<InferenceSelection>): InferenceSelection {
  const s = readInference();
  return {
    provider: s.provider,
    model: s.model,
    cloudProvider: s.cloudProvider,
    cloudModel: s.cloudModel,
    temperature: s.temperature,
    numCtx: s.numCtx,
    embedMode: s.embedMode,
    thinking: false,
    broad: false,
    hybrid: "off",
    ...extra,
  };
}

function modelLabel(sel: InferenceSelection): string {
  return `${sel.provider === "ollama" ? "ollama" : sel.cloudProvider}:${sel.provider === "ollama" ? sel.model : sel.cloudModel}`;
}

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

export const api = {
  // Library ---------------------------------------------------------------
  listDocuments: (params: Record<string, string | number | undefined> = {}) =>
    listDocuments(params as { q?: string; collection_id?: string; tag_id?: string; year?: string; doc_type?: string }),
  getDocument: (id: string) => getDocument(id),
  updateDocument: (id: string, patch: Record<string, unknown>) => updateDocument(id, patch),
  deleteDocument: (id: string) => deleteDocument(id),
  setCollections: (id: string, ids: string[]) => setDocCollections(id, ids),
  setTags: (id: string, ids: string[]) => setDocTags(id, ids),
  collections: () => listCollections(),
  createCollection: (body: { name: string }) => createCollection(body.name),
  tags: () => listTags(),
  createTag: (body: { name: string }) => createTag(body.name),
  stats: async () => {
    const s = await libraryStats();
    return { total: s.total };
  },
  health: async () => {
    const s = await libraryStats();
    const chunks = await chunkCount();
    return { documents: s.total, collections: s.collections, tags: s.tags, chroma_chunks: chunks, chroma_status: "ready", engine: "supabase" };
  },

  // Search ------------------------------------------------------------------
  search: (q: string) => groupedSearch(q, readInference().embedMode),
  searches: () => listSavedSearches(),
  createSearch: (body: { name: string; query: string }) => createSavedSearch(body.name, body.query),
  deleteSearch: (id: string) => deleteSavedSearch(id),
  runSearch: async (id: string) => {
    const saved = await listSavedSearches();
    const s = saved.find((x) => x.id === id);
    if (!s) throw new Error("Saved search not found");
    return groupedSearch(s.query, readInference().embedMode);
  },

  // Ask / research ------------------------------------------------------------
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
  summarize: async (body: { document_id: string }) => {
    const doc = await getDocument(body.document_id);
    return wbSummarize(doc, toSel());
  },
  summarizeStream: async (
    body: { document_id: string },
    handlers: { onStatus?: (stage: string, detail?: string) => void; onDone?: (data: { summary: string; stats: unknown }) => void; onError?: (err: string) => void },
  ) => {
    try {
      handlers.onStatus?.("preparing");
      const doc = await getDocument(body.document_id);
      handlers.onStatus?.("synthesizing");
      const r = await wbSummarize(doc, toSel());
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
  synthesis: (document_ids: string[], question: string) => wbSynthesis(document_ids, question, toSel()),
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

  // Citations -------------------------------------------------------------------
  citationStyles: () => listStyles(),
  citationStyleDefault: async (style: string) => {
    setDefaultStyle(style);
    return { ok: true };
  },
  citationStyleCustom: async (xml: string) => {
    saveCustomStyle(xml);
    return { styles: (await listStyles()).styles };
  },
  citationStyleFetch: async (name: string) => {
    const style = await fetchStyleFromRepo(name);
    return { styles: (await listStyles()).styles, style };
  },
  citations: async (docId: string, style?: string) => {
    const doc = await getDocument(docId);
    const item = docToCslItem(doc);
    const [citation, bibliography] = await Promise.all([
      renderCitation(item, style).catch(() => plainCitation(doc)),
      renderBibliography([item], style).catch(() => [plainCitation(doc)]),
    ]);
    return {
      plain: plainCitation(doc),
      style: style ?? "apa",
      citation: bibliography[0] ?? citation,
      bibtex: bibtexEntry(doc),
      ris: risEntry(doc),
      csl_json: item,
    };
  },

  // Import / export ---------------------------------------------------------------
  importRefs: async (text: string, format?: string) => {
    const records = parseReferences(text, format);
    return importRecords(records);
  },
  importFile: async (file: File) => {
    const text = await file.text();
    const ext = file.name.split(".").pop()?.toLowerCase();
    const fmt = ext === "bib" ? "bibtex" : ext === "ris" ? "ris" : ext === "json" ? "csl-json" : ext === "xml" ? "endnote-xml" : undefined;
    return importRecords(parseReferences(text, fmt));
  },
  exportRefs: async (format: string, ids?: string[]) => {
    const docs = await exportDocs(ids);
    const fmt = format.toLowerCase();
    if (fmt === "ris") return { data: docs.map(risEntry).join("\n") };
    if (fmt === "csl-json" || fmt === "csl_json" || fmt === "json") {
      return { data: JSON.stringify(docs.map(docToCslItem), null, 2) };
    }
    return { data: docs.map(bibtexEntry).join("\n\n") };
  },
  exportBibliography: async (style: string, ids?: string[]) => {
    const docs = await exportDocs(ids);
    const entries = await renderBibliography(docs.map(docToCslItem), style).catch(() => docs.map((d) => plainCitation(d)));
    return { bibliography: entries };
  },

  // Related / references / annotations / legal ----------------------------------------
  related: async (docId: string) => {
    const doc = await getDocument(docId);
    return relatedDocuments(doc);
  },
  references: (docId: string, resolve?: boolean) => documentReferences(docId, !!resolve),
  annotations: (docId: string) => listAnnotations(docId),
  createAnnotation: (docId: string, body: { page?: number; selected_text: string; note?: string; color?: string }) =>
    wbCreateAnnotation(docId, body),
  patchAnnotation: async (docId: string, aid: string, body: { note?: string; color?: string; page?: number; tags?: string[]; project_id?: string; claim_id?: string }) => {
    const patch: Record<string, unknown> = {};
    if (body.note !== undefined) patch.note = body.note;
    if (body.color !== undefined) patch.color = body.color;
    if (body.page !== undefined) patch.page = body.page;
    if (body.tags !== undefined) patch.tags_json = body.tags;
    if (body.project_id !== undefined) patch.project_id = body.project_id || null;
    if (body.claim_id !== undefined) patch.claim_id = body.claim_id || null;
    const { error } = await createClient().from("annotations").update(patch).eq("id", aid).eq("document_id", docId);
    if (error) throw new Error(error.message);
    return { ok: true };
  },
  legalRefresh: (docId: string) => wbLegalRefresh(docId),
  citedCases: (docId: string) => wbCitedCases(docId),
  casesCiting: async (caseNumber: string) => {
    const ws = await getWorkspaceId();
    const sb = createClient();
    const { data } = await sb
      .from("source_citations")
      .select("sources!inner(workspace_id, documents(id, title))")
      .eq("cited_identifier", caseNumber.toUpperCase())
      .eq("sources.workspace_id", ws);
    return ((data ?? []) as unknown as Array<{ sources: { documents: { id: string; title: string } | null } | null }>)
      .map((r) => r.sources?.documents)
      .filter((d): d is { id: string; title: string } => !!d);
  },

  // Projects / claims ---------------------------------------------------------------
  projects: () => listProjects(),
  createProject: (body: { name: string; description?: string; document_ids?: string[] }) =>
    wbCreateProject(body.name, body.description ?? "", body.document_ids ?? []),
  getProject: (id: string) => wbGetProject(id),
  deleteProject: (id: string) => wbDeleteProject(id),
  addProjectEvidence: (projectId: string, claim: string, quotedEvidence: string) => addEvidence(projectId, claim, quotedEvidence),
  projectClaims: (pid: string) => wbProjectClaims(pid),
  createClaim: (body: { project_id?: string | null; text: string }) => wbCreateClaim(body.project_id ?? null, body.text),
  deleteClaim: (id: string) => wbDeleteClaim(id),
  claimAddCitation: (cid: string, body: { document_id: string; support: string; locator?: string | null }) =>
    wbClaimAddCitation(cid, body.document_id, body.support, body.locator ?? null),

  // Config / settings (local-device state; same localStorage keys as contexts) --------
  config: () => Promise.resolve(readConfig()),
  updateConfig: async (payload: Record<string, string>) => {
    const s = readInference();
    const next = { ...s };
    if (payload.chat_model !== undefined) next.model = payload.chat_model.trim() || INFERENCE_DEFAULTS.model;
    if (payload.chat_num_ctx?.trim()) next.numCtx = Number(payload.chat_num_ctx);
    if (payload.chat_temperature?.trim()) next.temperature = Number(payload.chat_temperature);
    if (payload.chat_num_predict?.trim()) next.numPredict = Number(payload.chat_num_predict);
    try {
      localStorage.setItem(INFERENCE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return Promise.resolve(readConfig());
  },
  settings: async () => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    } catch {
      return {};
    }
  },
  updateSettings: async (body: Record<string, string>) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(body));
    } catch {
      /* ignore */
    }
    return body;
  },
  documentFileUrl: (doc: { storage_path?: string | null }) => documentFileUrl(doc),
};

async function exportDocs(ids?: string[]): Promise<HydratedDoc[]> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  let q = sb.from("documents").select("*").eq("workspace_id", ws).eq("status", "approved").limit(1000);
  if (ids?.length) q = q.in("id", ids);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const { hydrateDocs } = await import("./wb/library");
  return hydrateDocs((data ?? []) as Array<Record<string, unknown>>);
}

async function importRecords(records: ImportRecord[]): Promise<{ imported: number; skipped: number }> {
  if (!records.length) return { imported: 0, skipped: 0 };
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  const { data: existing } = await sb.from("documents").select("id, title, doi").eq("workspace_id", ws).limit(2000);
  const existingDocs = ((existing ?? []) as Array<{ id: string; title: string | null; doi: string | null }>).map((d) => ({
    id: d.id,
    title: d.title,
    doi: d.doi,
  }));
  let imported = 0;
  let skipped = 0;
  for (const r of records) {
    const dups = checkDuplicates(
      { title: r.title, doi: r.doi, authors: r.authors, year: r.year },
      existingDocs,
    );
    if (dups.length) {
      skipped++;
      continue;
    }
    const { data: doc, error } = await sb
      .from("documents")
      .insert({
        workspace_id: ws,
        title: r.title ?? "(untitled)",
        original_filename: `${r.rawKey ?? r.title ?? "import"}.ref`,
        doi: r.doi,
        year: r.year,
        journal: r.journal,
        volume: r.volume,
        issue: r.issue,
        pages: r.pages,
        publisher: r.publisher,
        abstract: r.abstract,
        ingestion_status: "metadata_only",
        status: "pending",
        uploaded_by: me.user?.id ?? null,
      })
      .select("id")
      .single();
    if (error || !doc) {
      skipped++;
      continue;
    }
    const docId = (doc as { id: string }).id;
    if (r.authors.length) {
      for (let i = 0; i < r.authors.length; i++) {
        const name = r.authors[i];
        const { data: ex } = await sb.from("authors").select("id").eq("workspace_id", ws).eq("name", name).maybeSingle();
        let authorId = (ex as { id: string } | null)?.id;
        if (!authorId) {
          const { data: cr } = await sb.from("authors").insert({ workspace_id: ws, name }).select("id").single();
          authorId = (cr as { id: string } | null)?.id;
        }
        if (authorId) await sb.from("document_authors").insert({ document_id: docId, author_id: authorId, author_order: i });
      }
    }
    for (const cname of r.collections.slice(0, 5)) {
      const { data: ex } = await sb.from("collections").select("id").eq("workspace_id", ws).eq("name", cname).maybeSingle();
      let colId = (ex as { id: string } | null)?.id;
      if (!colId) {
        const { data: cr } = await sb.from("collections").insert({ workspace_id: ws, name: cname }).select("id").single();
        colId = (cr as { id: string } | null)?.id;
      }
      if (colId) await sb.from("document_collections").insert({ document_id: docId, collection_id: colId });
    }
    existingDocs.push({ id: docId, title: r.title, doi: r.doi });
    imported++;
  }
  return { imported, skipped };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readConfig() {
  const s = readInference();
  return {
    rag_provider: "ollama",
    rag_model: s.model,
    thinking_available: true,
    chat: { model: s.model, num_ctx: s.numCtx, ctx_safety_margin: 800, temperature: s.temperature, num_predict: s.numPredict ?? 2048 },
  };
}
