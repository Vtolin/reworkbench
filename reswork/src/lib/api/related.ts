// Feature API: related documents, references, annotations, legal.
// Extracted verbatim from lib/api.ts (Phase 5); behavior unchanged.
// (patchAnnotation / casesCiting issue direct Supabase queries, as before;
// repository extraction belongs to Phase 6.)
import { createClient } from "../supabase/client";
import { getDocument, getWorkspaceId } from "../wb/library";
import {
  relatedDocuments, documentReferences, listAnnotations, createAnnotation as wbCreateAnnotation,
  legalRefresh as wbLegalRefresh, citedCases as wbCitedCases,
} from "../wb/related";

export const relatedApi = {
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
};
