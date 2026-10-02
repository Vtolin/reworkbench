// Feature API: library (documents, collections, tags, stats).
// Thin delegates over lib/wb/library. Extracted verbatim from lib/api.ts
// (Phase 5); behavior unchanged.
import {
  listDocuments, getDocument, updateDocument, deleteDocument,
  setDocCollections, setDocTags, listCollections, createCollection,
  listTags, createTag, libraryStats, chunkCount,
  documentFileUrl as wbDocumentFileUrl,
} from "../wb/library";

export const libraryApi = {
  listDocuments: (params: Record<string, string | number | undefined> = {}) =>
    listDocuments(params as { q?: string; collection_id?: string; tag_id?: string; year?: string; doc_type?: string; limit?: number; offset?: number }),
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
};

export const documentFileUrl = (doc: { storage_path?: string | null }) => wbDocumentFileUrl(doc);
