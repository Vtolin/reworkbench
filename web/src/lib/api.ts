const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text();
    let msg = txt;
    try { msg = JSON.parse(txt).detail || txt; } catch {}
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  // 204 no content
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export const api = {
  health: () => apiFetch("/api/health"),
  config: () => apiFetch("/api/config"),
  updateConfig: (body: any) => apiFetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  stats: () => apiFetch("/api/library/stats"),
  listDocuments: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v)); });
    const q = qs.toString();
    return apiFetch(`/api/library/documents${q ? `?${q}` : ""}`);
  },
  getDocument: (id: number) => apiFetch(`/api/library/documents/${id}`),
  updateDocument: (id: number, patch: any) => apiFetch(`/api/library/documents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }),
  deleteDocument: (id: number) => apiFetch(`/api/library/documents/${id}`, { method: "DELETE" }),
  setCollections: (id: number, ids: number[]) => apiFetch(`/api/library/documents/${id}/collections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection_ids: ids }) }),
  setTags: (id: number, ids: number[]) => apiFetch(`/api/library/documents/${id}/tags`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag_ids: ids }) }),
  collections: () => apiFetch("/api/library/collections"),
  createCollection: (body: any) => apiFetch("/api/library/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteCollection: (id: number) => apiFetch(`/api/library/collections/${id}`, { method: "DELETE" }),
  tags: () => apiFetch("/api/library/tags"),
  createTag: (body: any) => apiFetch("/api/library/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteTag: (id: number) => apiFetch(`/api/library/tags/${id}`, { method: "DELETE" }),
  ingestPreview: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch("/api/ingest/preview", { method: "POST", body: fd as any });
  },
  ingestConfirm: (body: any) => apiFetch("/api/ingest/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  search: (q: string) => apiFetch(`/api/search?q=${encodeURIComponent(q)}`),
  ask: (body: any) => apiFetch("/api/research/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  askStream: async (
    body: any,
    handlers: {
      onMeta?: (data: any) => void;
      onStatus?: (stage: string, detail?: string) => void;
      onThinking?: (delta: string) => void;
      onToken?: (delta: string) => void;
      onDone?: (data: any) => void;
      onError?: (err: string) => void;
    },
    signal?: AbortSignal
  ) => {
    const res = await fetch(`${API}/api/research/ask/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try { msg = JSON.parse(txt).detail || txt; } catch {}
      throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    if (!res.body) throw new Error("No stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        try {
          const data = JSON.parse(jsonStr);
          if (data.type === "meta") handlers.onMeta?.(data);
          else if (data.type === "status") handlers.onStatus?.(data.stage, data.detail);
          else if (data.type === "thinking") handlers.onThinking?.(data.delta);
          else if (data.type === "token") handlers.onToken?.(data.delta);
          else if (data.type === "done") handlers.onDone?.(data);
          else if (data.type === "error") handlers.onError?.(data.error);
        } catch {}
      }
    }
  },
  clearMemory: (session_id?: string) => apiFetch(`/api/research/memory/clear${session_id ? `?session_id=${encodeURIComponent(session_id)}` : ""}`, { method: "POST" }),
  memoryStatus: (session_id?: string) => apiFetch(`/api/research/memory${session_id ? `?session_id=${encodeURIComponent(session_id)}` : ""}`),
  summarize: (body: any) => apiFetch("/api/research/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  compare: (body: any) => apiFetch("/api/research/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  trail: () => apiFetch("/api/research/trail"),
  // CSL citation engine (Phase 2)
  citationStyles: () => apiFetch("/api/citations/styles"),
  citationStyleDefault: (style: string) => apiFetch("/api/citations/styles/default", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style }) }),
  citationStyleCustom: (xml: string) => apiFetch("/api/citations/styles/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ xml }) }),
  citationStyleFetch: (name: string) => apiFetch("/api/citations/styles/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }),
  // Import / export (Phase 3) — One-Click Importer
  importRefs: (text: string, format?: string) => apiFetch("/api/import/refs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, format }) }),
  importFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch("/api/import/file", { method: "POST", body: fd as any });
  },
  exportRefs: (format: string, ids?: number[]) => apiFetch(`/api/export/refs?format=${format}${ids?.length ? `&ids=${ids.join(",")}` : ""}`),
  exportBibliography: (style: string, ids?: number[]) => apiFetch(`/api/export/bibliography?style=${style}${ids?.length ? `&ids=${ids.join(",")}` : ""}`),
  // Browser capture (Phase 4)
  capture: (body: any) => apiFetch("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  // Literature matrix (Phase 5)
  matrix: (document_ids: number[]) => apiFetch("/api/research/matrix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_ids }) }),
  matrixExport: async (rows: any[], format: string) => {
    const fmt = format.toLowerCase();
    const res = await fetch(`${API}/api/research/matrix/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, format: fmt }),
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try { msg = JSON.parse(txt).detail || txt; } catch {}
      throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    if (fmt === "xlsx") return res.blob();
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res.text();
  },
  // Saved searches (Phase 5)
  searches: () => apiFetch("/api/searches"),
  createSearch: (body: any) => apiFetch("/api/searches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteSearch: (id: number) => apiFetch(`/api/searches/${id}`, { method: "DELETE" }),
  runSearch: (id: number) => apiFetch(`/api/searches/${id}/run`, { method: "POST" }),
  // Related documents (Phase 5)
  related: (docId: number) => apiFetch(`/api/library/documents/${docId}/related`),
  // Claims (Phase 6)
  projectClaims: (pid: number) => apiFetch(`/api/projects/${pid}/claims`),
  createClaim: (body: any) => apiFetch("/api/claims", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  deleteClaim: (id: number) => apiFetch(`/api/claims/${id}`, { method: "DELETE" }),
  claimAddCitation: (cid: number, body: any) => apiFetch(`/api/claims/${cid}/citations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  // Reader references (Phase 7)
  references: (docId: number, resolve?: boolean) => apiFetch(`/api/library/documents/${docId}/references${resolve ? "?resolve=true" : ""}`),
  patchAnnotation: (docId: number, aid: number, body: any) => apiFetch(`/api/library/documents/${docId}/annotations/${aid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  // Legal intelligence (Phase 8)
  legalRefresh: (docId: number) => apiFetch(`/api/library/documents/${docId}/legal/refresh`, { method: "POST" }),
  citedCases: (docId: number) => apiFetch(`/api/library/documents/${docId}/cited-cases`),
  casesCiting: (caseNumber: string) => apiFetch(`/api/cases/citing?case_number=${encodeURIComponent(caseNumber)}`),
  legalAnalysis: (document_id: number) => apiFetch("/api/research/legal-analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_id }) }),
  // Structured extraction + synthesis (Phase 9)
  extract: (document_id: number, schema: string) => apiFetch("/api/research/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_id, schema }) }),
  synthesis: (document_ids: number[], question: string) => apiFetch("/api/research/synthesis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_ids, question }) }),
  // Summarization PDF/HTML export
  summarizeStream: async (
    body: any,
    handlers: {
      onStatus?: (stage: string, detail?: string, progress?: { current: number; total: number }) => void;
      onDone?: (data: any) => void;
      onError?: (err: string) => void;
    },
    signal?: AbortSignal
  ) => {
    const res = await fetch(`${API}/api/research/summarize/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try { msg = JSON.parse(txt).detail || txt; } catch {}
      throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    if (!res.body) throw new Error("No stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        try {
          const data = JSON.parse(jsonStr);
          if (data.type === "status") handlers.onStatus?.(data.stage, data.detail, data.current != null && data.total != null ? { current: data.current, total: data.total } : undefined);
          else if (data.type === "done") handlers.onDone?.(data);
          else if (data.type === "error") handlers.onError?.(data.error);
        } catch {}
      }
    }
  },
  summarizeExport: async (document_id: number, format: string) => {
    const res = await fetch(`${API}/api/research/summarize/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id, format }),
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = txt;
      try { msg = JSON.parse(txt).detail || txt; } catch {}
      throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    return res.blob();
  },
  // Watch-folder
  watchStatus: () => apiFetch("/api/watch/status"),
  watchToggle: (enabled?: boolean) => apiFetch("/api/watch/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }),
  settings: () => apiFetch("/api/settings"),
  updateSettings: (body: any) => apiFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  projects: () => apiFetch("/api/research/projects"),
  createProject: (body: any) => apiFetch("/api/research/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  getProject: (id: number) => apiFetch(`/api/research/projects/${id}`),
  deleteProject: (id: number) => apiFetch(`/api/research/projects/${id}`, { method: "DELETE" }),
  annotations: (docId: number) => apiFetch(`/api/library/documents/${docId}/annotations`),
  createAnnotation: (docId: number, body: any) => apiFetch(`/api/library/documents/${docId}/annotations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  notes: (docId?: number) => apiFetch(`/api/library/notes${docId ? `?document_id=${docId}` : ""}`),
  citations: (docId: number, style?: string) => apiFetch(`/api/citations/${docId}${style ? `?style=${encodeURIComponent(style)}` : ""}`),
};
