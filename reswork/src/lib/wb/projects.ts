// Research projects, claims/evidence graph, research trail (Supabase-backed).
// Replaces /api/research/projects, /api/claims, /api/research/trail.
import { createClient } from "@/lib/supabase/client";
import { chunkArray } from "@/lib/async/pool";
import { DOCUMENT_COLUMNS_SELECT, getWorkspaceId, hydrateDocs, type HydratedDoc } from "./library";

export interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  documents: HydratedDoc[];
  evidence: Array<{ id: string; claim: string; quoted_evidence: string; location: string | null; created_at: string }>;
  queries: Array<{ id: string; query: string; answer: string | null; sources_json: unknown; created_at: string }>;
}

export async function listProjects(): Promise<Array<{ id: string; name: string; description: string; document_count: number; updated_at: string }>> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data, error } = await sb.from("research_projects").select("id, name, description, updated_at").eq("workspace_id", ws).order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  // Set-based counts (migration 0007): one GROUP BY RPC instead of one
  // head-count query per project (1+N -> 2 queries total).
  const { data: counts, error: countErr } = await sb.rpc("project_doc_counts", { ws_id: ws });
  if (countErr) throw new Error(countErr.message);
  const byId = new Map(
    ((counts ?? []) as Array<{ project_id: string; document_count: number }>).map((c) => [c.project_id, Number(c.document_count)]),
  );
  return ((data ?? []) as Array<{ id: string; name: string; description: string; updated_at: string }>).map((p) => ({
    ...p,
    document_count: byId.get(p.id) ?? 0,
  }));
}

export async function createProject(name: string, description: string, documentIds: string[]): Promise<void> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  const { data: proj, error } = await sb
    .from("research_projects")
    .insert({ workspace_id: ws, name, description: description ?? "", created_by: me.user?.id ?? null })
    .select("id")
    .single();
  if (error || !proj) throw new Error(error?.message ?? "Project creation failed");
  const pid = (proj as { id: string }).id;
  if (documentIds.length) {
    const { error: linkErr } = await sb
      .from("research_project_documents")
      .insert(documentIds.map((document_id) => ({ project_id: pid, document_id })));
    if (linkErr) throw new Error(linkErr.message);
  }
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const sb = createClient();
  const { data: proj, error } = await sb.from("research_projects").select("id, name, description").eq("id", id).single();
  if (error || !proj) throw new Error(error?.message ?? "Project not found");
  const p = proj as { id: string; name: string; description: string };
  const [{ data: links }, { data: evidence }, { data: queries }] = await Promise.all([
    sb.from("research_project_documents").select("document_id").eq("project_id", id),
    sb.from("evidence_items").select("id, claim, quoted_evidence, location, created_at").eq("project_id", id).order("created_at"),
    sb.from("research_queries").select("id, query, answer, sources_json, created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  const docIds = ((links ?? []) as Array<{ document_id: string }>).map((l) => l.document_id);
  let documents: HydratedDoc[] = [];
  if (docIds.length) {
    // Chunked: a project can link thousands of documents (hydrateDocs chunks
    // its own joins internally, but this fetch needs batching too).
    const docRows: Array<Record<string, unknown>> = [];
    for (const batch of chunkArray(docIds)) {
      const { data: docs } = await sb.from("documents").select(DOCUMENT_COLUMNS_SELECT).in("id", batch);
      docRows.push(...(((docs ?? []) as unknown) as Array<Record<string, unknown>>));
    }
    documents = await hydrateDocs(docRows);
  }
  return {
    ...p,
    documents,
    evidence: (evidence ?? []) as ProjectDetail["evidence"],
    queries: (queries ?? []) as ProjectDetail["queries"],
  };
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await createClient().from("research_projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function addEvidence(projectId: string, claim: string, quotedEvidence: string): Promise<void> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  const { error } = await sb.from("evidence_items").insert({
    workspace_id: ws,
    project_id: projectId,
    claim,
    quoted_evidence: quotedEvidence,
    created_by: me.user?.id ?? null,
  });
  if (error) throw new Error(error.message);
}

export interface ClaimWithEvidence {
  id: string;
  text: string;
  status: string;
  evidence: Record<string, Array<{ title: string; locator: string | null }>>;
}

export async function projectClaims(projectId: string): Promise<ClaimWithEvidence[]> {
  const sb = createClient();
  const { data: claims, error } = await sb.from("claims").select("id, text, status").eq("project_id", projectId).order("created_at");
  if (error) throw new Error(error.message);
  const claimRows = (claims ?? []) as Array<{ id: string; text: string; status: string }>;
  // One query for all claims' citations (1+N -> 2 queries total), grouped in
  // memory. Chunked so a claim-heavy project never builds an unbounded IN.
  const citRows: Array<{
    claim_id: string; support: string; locator: string | null;
    sources: { title: string | null; documents: { title: string } | null } | null;
  }> = [];
  for (const batch of chunkArray(claimRows.map((c) => c.id))) {
    const { data: cits } = await sb
      .from("citations")
      .select("claim_id, support, locator, sources(id, title, document_id, documents(id, title))")
      .in("claim_id", batch);
    citRows.push(...(((cits ?? []) as unknown) as typeof citRows));
  }
  const byClaim = new Map<string, typeof citRows>();
  for (const cit of citRows) {
    const arr = byClaim.get(cit.claim_id) ?? [];
    arr.push(cit);
    byClaim.set(cit.claim_id, arr);
  }
  return claimRows.map((c) => {
    const evidence: ClaimWithEvidence["evidence"] = { supports: [], contradicts: [], mentions: [] };
    for (const cit of byClaim.get(c.id) ?? []) {
      const title = cit.sources?.documents?.title ?? cit.sources?.title ?? "(untitled)";
      (evidence[cit.support] ?? (evidence[cit.support] = [])).push({ title, locator: cit.locator });
    }
    return { ...c, evidence };
  });
}

export async function createClaim(projectId: string | null, text: string): Promise<void> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  const { error } = await sb.from("claims").insert({
    workspace_id: ws,
    project_id: projectId,
    text,
    created_by: me.user?.id ?? null,
  });
  if (error) throw new Error(error.message);
}

export async function deleteClaim(id: string): Promise<void> {
  const { error } = await createClient().from("claims").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function claimAddCitation(claimId: string, documentId: string, support: string, locator: string | null): Promise<void> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  // Resolve document → source row (create the source row if missing).
  const { data: doc } = await sb.from("documents").select("id, title, doi, journal, year").eq("id", documentId).single();
  let sourceId: string | null = null;
  const { data: existing } = await sb.from("sources").select("id").eq("document_id", documentId).limit(1).maybeSingle();
  sourceId = (existing as { id: string } | null)?.id ?? null;
  if (!sourceId && doc) {
    const d = doc as { title: string; doi: string | null; journal: string | null; year: number | null };
    const { data: created, error } = await sb
      .from("sources")
      .insert({ workspace_id: ws, document_id: documentId, title: d.title, doi: d.doi, journal: d.journal, year: d.year })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    sourceId = (created as { id: string }).id;
  }
  if (!sourceId) throw new Error("Could not resolve source");
  const { error } = await sb.from("citations").insert({ workspace_id: ws, source_id: sourceId, claim_id: claimId, support, locator });
  if (error) throw new Error(error.message);
}

// Research trail: project-scoped ask persists a research_queries row (answer +
// sources_json) so the trail survives refresh; the shared event log mirrors it.
export async function recordQuery(opts: {
  projectId: string | null;
  query: string;
  answer: string;
  sources: unknown;
  modelUsed: string;
}): Promise<void> {
  const ws = await getWorkspaceId();
  const sb = createClient();
  const { data: me } = await sb.auth.getUser();
  await sb.from("research_queries").insert({
    workspace_id: ws,
    project_id: opts.projectId,
    query: opts.query,
    answer: opts.answer,
    model_used: opts.modelUsed,
    sources_json: (opts.sources ?? []) as never,
    created_by: me.user?.id ?? null,
  });
  await fetch("/api/research/trail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: ws,
      projectId: opts.projectId,
      event_type: "query",
      payload: { query: opts.query, model: opts.modelUsed },
    }),
  }).catch(() => {});
}
