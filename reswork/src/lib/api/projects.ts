// Feature API: research projects + claims graph.
// Thin delegates over lib/wb/projects. Extracted verbatim from lib/api.ts
// (Phase 5); behavior unchanged.
import {
  listProjects, createProject as wbCreateProject, getProject as wbGetProject,
  deleteProject as wbDeleteProject, addEvidence, projectClaims as wbProjectClaims,
  createClaim as wbCreateClaim, deleteClaim as wbDeleteClaim,
  claimAddCitation as wbClaimAddCitation,
} from "../wb/projects";

export const projectsApi = {
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
};
