// Related documents (labeled relations), reference extraction + resolution,
// annotations, and legal graph refresh — Supabase-backed ports of the
// corresponding FastAPI endpoints.
import { createClient } from "@/lib/supabase/client";
import { titleFuzzyScore } from "@/lib/ingestion/dedup";
import { extractCaseMetadata, extractCitedIdentifiers, normalizeCaseNumber } from "@/lib/legal/extraction";
import { getDocument, type HydratedDoc } from "./library";

export interface RelatedResult {
  citations: Array<{ id: string; title: string; reason: string }>;
  shared_authors: Array<{ id: string; title: string; reason: string }>;
  shared_topics: Array<{ id: string; title: string; reason: string }>;
  semantic: Array<{ id: string; title: string; reason: string }>;
}

export async function relatedDocuments(doc: HydratedDoc): Promise<RelatedResult> {
  const sb = createClient();
  const out: RelatedResult = { citations: [], shared_authors: [], shared_topics: [], semantic: [] };

  // Labeled relation 1: citation graph edges via source_citations.
  const { data: src } = await sb.from("sources").select("id, case_number").eq("document_id", doc.id).limit(1).maybeSingle();
  const source = src as { id: string; case_number: string | null } | null;
  if (source) {
    const { data: edges } = await sb.from("source_citations").select("cited_identifier, kind").eq("source_id", source.id).limit(20);
    for (const e of (edges ?? []) as Array<{ cited_identifier: string; kind: string }>) {
      out.citations.push({ id: "", title: e.cited_identifier, reason: `cited here (${e.kind})` });
    }
    if (source.case_number) {
      const { data: citing } = await sb
        .from("source_citations")
        .select("source_id, sources!inner(id, document_id, documents(id, title))")
        .eq("cited_identifier", source.case_number)
        .limit(10);
      for (const c of ((citing ?? []) as unknown as Array<{
        sources: { documents: { id: string; title: string } | null } | null;
      }>)) {
        if (c.sources?.documents) {
          out.citations.push({ id: c.sources.documents.id, title: c.sources.documents.title, reason: "cites this case" });
        }
      }
    }
  }

  // Labeled relation 2: shared authors.
  if (doc.authors.length) {
    const { data: authorRows } = await sb.from("authors").select("id").in("name", doc.authors);
    const authorIds = ((authorRows ?? []) as Array<{ id: string }>).map((a) => a.id);
    if (authorIds.length) {
      const { data: links } = await sb.from("document_authors").select("document_id, author_id").in("author_id", authorIds).limit(100);
      const counts = new Map<string, number>();
      for (const l of (links ?? []) as Array<{ document_id: string }>) {
        if (l.document_id === doc.id) continue;
        counts.set(l.document_id, (counts.get(l.document_id) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (top.length) {
        const { data: docs } = await sb.from("documents").select("id, title").in("id", top.map(([id]) => id));
        const titles = new Map(((docs ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]));
        for (const [id, n] of top) {
          out.shared_authors.push({ id, title: titles.get(id) ?? id.slice(0, 8), reason: `shared author(s) (${n})` });
        }
      }
    }
  }

  // Labeled relation 3: shared topics (tags + collections).
  const topicDocIds = new Map<string, string[]>();
  if (doc.tags.length) {
    const { data: links } = await sb.from("document_tags").select("document_id, tag_id, tags(name)").in("tag_id", doc.tags.map((t) => t.id)).limit(200);
    for (const l of ((links ?? []) as unknown as Array<{ document_id: string; tags: { name: string } | null }>)) {
      if (l.document_id === doc.id) continue;
      const arr = topicDocIds.get(l.document_id) ?? [];
      if (l.tags) arr.push(`#${l.tags.name}`);
      topicDocIds.set(l.document_id, arr);
    }
  }
  if (doc.collections.length) {
    const { data: links } = await sb.from("document_collections").select("document_id, collection_id, collections(name)").in("collection_id", doc.collections.map((c) => c.id)).limit(200);
    for (const l of ((links ?? []) as unknown as Array<{ document_id: string; collections: { name: string } | null }>)) {
      if (l.document_id === doc.id) continue;
      const arr = topicDocIds.get(l.document_id) ?? [];
      if (l.collections) arr.push(l.collections.name);
      topicDocIds.set(l.document_id, arr);
    }
  }
  const topicTop = [...topicDocIds.entries()].slice(0, 10);
  if (topicTop.length) {
    const { data: docs } = await sb.from("documents").select("id, title").in("id", topicTop.map(([id]) => id));
    const titles = new Map(((docs ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]));
    for (const [id, topics] of topicTop) {
      out.shared_topics.push({ id, title: titles.get(id) ?? id.slice(0, 8), reason: `shared topics: ${[...new Set(topics)].slice(0, 3).join(", ")}` });
    }
  }

  // Labeled relation 4: semantic similarity (averaged chunk embeddings).
  try {
    const { data: embs } = await sb.from("document_embeddings").select("embedding, document_chunks!inner(document_id)").eq("document_chunks.document_id", doc.id).limit(50);
    const rows = (embs ?? []) as Array<{ embedding: number[] }>;
    if (rows.length) {
      const dim = rows[0].embedding.length;
      const avg = new Array<number>(dim).fill(0);
      for (const r of rows) for (let i = 0; i < dim; i++) avg[i] += r.embedding[i] / rows.length;
      const { getWorkspaceId: getWs } = await import("./library");
      const { data: near } = await sb.rpc("vector_search_chunks", {
        ws_id: await getWs(),
        query_embedding: avg,
        match_count: 30,
      });
      const seen = new Map<string, number>();
      for (const n of (near ?? []) as Array<{ document_id: string }>) {
        if (n.document_id === doc.id) continue;
        seen.set(n.document_id, (seen.get(n.document_id) ?? 0) + 1);
      }
      const topSem = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (topSem.length) {
        const { data: docs } = await sb.from("documents").select("id, title").in("id", topSem.map(([id]) => id));
        for (const d of (docs ?? []) as Array<{ id: string; title: string }>) {
          out.semantic.push({ id: d.id, title: d.title, reason: "semantic similarity (embeddings)" });
        }
      }
    }
  } catch {
    /* vector leg optional */
  }
  return out;
}

export interface DocReference {
  number: number;
  text: string;
  match: { id: string; title: string; score: number } | null;
}

// Extract "[23] Author…" lines from chunk text; fuzzy-match against the
// library (title_fuzzy_score ≥ 0.55) like the old /references endpoint.
export async function documentReferences(docId: string, resolve: boolean): Promise<{ references: DocReference[] }> {
  const sb = createClient();
  const { data: chunks } = await sb.from("document_chunks").select("content").eq("document_id", docId).order("chunk_index").limit(300);
  const text = ((chunks ?? []) as Array<{ content: string }>).map((c) => c.content).join("\n");
  const refs: Array<{ number: number; text: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)\s*$/);
    if (m) refs.push({ number: Number(m[1]), text: m[2].slice(0, 500) });
  }
  if (!resolve || !refs.length) return { references: refs.map((r) => ({ ...r, match: null })) };
  const { getWorkspaceId: getWs2 } = await import("./library");
  const wsId = await getWs2();
  const { data: lib } = await sb.from("documents").select("id, title").eq("workspace_id", wsId).eq("status", "approved").limit(500);
  const out: DocReference[] = refs.map((r) => {
    let best: { id: string; title: string; score: number } | null = null;
    for (const d of (lib ?? []) as Array<{ id: string; title: string }>) {
      if (d.id === docId || !d.title) continue;
      const score = titleFuzzyScore(r.text, d.title);
      if (score >= 0.55 && (!best || score > best.score)) best = { id: d.id, title: d.title, score };
    }
    return { ...r, match: best };
  });
  return { references: out };
}

// Annotations ---------------------------------------------------------------
export async function listAnnotations(docId: string) {
  const { data, error } = await createClient()
    .from("annotations")
    .select("*")
    .eq("document_id", docId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function createAnnotation(docId: string, body: { page?: number; selected_text: string; note?: string; color?: string }): Promise<void> {
  const sb = createClient();
  const { data: doc } = await sb.from("documents").select("workspace_id").eq("id", docId).single();
  if (!doc) throw new Error("Document not found");
  const { data: me } = await sb.auth.getUser();
  const { error } = await sb.from("annotations").insert({
    workspace_id: (doc as { workspace_id: string }).workspace_id,
    document_id: docId,
    page: body.page ?? 1,
    selected_text: body.selected_text,
    note: body.note ?? null,
    color: body.color ?? "#facc15",
    category: "highlight",
    created_by: me.user?.id ?? null,
  });
  if (error) throw new Error(error.message);
}

// Legal graph refresh (deterministic part of POST .../legal/refresh): reads
// chunk text, extracts case metadata + cited identifiers, writes sources +
// source_citations rows, patches documents.citation_metadata.
export async function legalRefresh(docId: string): Promise<{ court: string | null; case_number: string | null; citations: number }> {
  const sb = createClient();
  const { data: chunks } = await sb.from("document_chunks").select("content").eq("document_id", docId).order("chunk_index").limit(300);
  const text = ((chunks ?? []) as Array<{ content: string }>).map((c) => c.content).join("\n");
  const meta = extractCaseMetadata(text);
  const cited = extractCitedIdentifiers(text);

  const { data: doc } = await sb.from("documents").select("workspace_id, citation_metadata").eq("id", docId).single();
  if (!doc) throw new Error("Document not found");
  const wsId = (doc as { workspace_id: string }).workspace_id;

  let sourceId: string | null = null;
  const { data: ex } = await sb.from("sources").select("id").eq("document_id", docId).limit(1).maybeSingle();
  sourceId = (ex as { id: string } | null)?.id ?? null;
  if (!sourceId) {
    const { data: cr, error } = await sb
      .from("sources")
      .insert({ workspace_id: wsId, document_id: docId, source_type: "legal_case" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    sourceId = (cr as { id: string }).id;
  }
  await sb
    .from("sources")
    .update({
      court: meta.court,
      case_number: meta.case_number,
      decision_date: meta.decision_date,
      parties_json: meta.parties,
    })
    .eq("id", sourceId);
  await sb.from("source_citations").delete().eq("source_id", sourceId);
  for (const c of cited) {
    // Resolve cited_source_id via matching case_number.
    let citedSourceId: string | null = null;
    if (c.kind === "case") {
      const { data: hit } = await sb.from("sources").select("id").eq("workspace_id", wsId).eq("case_number", normalizeCaseNumber(c.identifier)).limit(1).maybeSingle();
      citedSourceId = (hit as { id: string } | null)?.id ?? null;
    }
    await sb.from("source_citations").insert({
      workspace_id: wsId,
      source_id: sourceId,
      cited_identifier: c.identifier,
      cited_source_id: citedSourceId,
      kind: c.kind,
      locator: c.locator,
    });
  }
  const prevMd = ((doc as { citation_metadata: Record<string, unknown> }).citation_metadata ?? {});
  await sb.from("documents").update({
    citation_metadata: { ...prevMd, court: meta.court, case_number: meta.case_number, parties: meta.parties },
  }).eq("id", docId);
  return { court: meta.court, case_number: meta.case_number, citations: cited.length };
}

export async function citedCases(docId: string): Promise<{ cited: Array<{ identifier: string; kind: string }>; citing: Array<{ id: string; title: string }> }> {
  const sb = createClient();
  const { data: src } = await sb.from("sources").select("id, case_number").eq("document_id", docId).limit(1).maybeSingle();
  const source = src as { id: string; case_number: string | null } | null;
  if (!source) return { cited: [], citing: [] };
  const { data: edges } = await sb.from("source_citations").select("cited_identifier, kind").eq("source_id", source.id);
  const cited = ((edges ?? []) as Array<{ cited_identifier: string; kind: string }>).map((e) => ({ identifier: e.cited_identifier, kind: e.kind }));
  let citing: Array<{ id: string; title: string }> = [];
  if (source.case_number) {
    const { data: rows } = await sb
      .from("source_citations")
      .select("sources!inner(documents(id, title))")
      .eq("cited_identifier", source.case_number);
    citing = (((rows ?? []) as unknown) as Array<{ sources: { documents: { id: string; title: string } | null } | null }>)
      .map((r) => r.sources?.documents)
      .filter((d): d is { id: string; title: string } => !!d);
  }
  return { cited, citing };
}
