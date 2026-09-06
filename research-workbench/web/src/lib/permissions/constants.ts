// Absolute server-side ceiling. Independent of the workspace soft limit.
// A compromised/modified client must not be able to raise it — every
// membership write path clamps to this value on the server.
export const MAX_ALLOWED_MEMBERS = 10;

export type WorkspaceRole = "admin" | "member";
export type MemberStatus = "active" | "removed";
export type DocumentStatus = "pending" | "approved" | "rejected";
export type ChatVisibility = "workspace" | "private";

export function clampMemberLimit(requested: unknown): number {
  const n =
    typeof requested === "number"
      ? requested
      : typeof requested === "string"
        ? Number.parseInt(requested, 10)
        : NaN;
  if (!Number.isFinite(n)) return MAX_ALLOWED_MEMBERS;
  return Math.max(1, Math.min(MAX_ALLOWED_MEMBERS, Math.floor(n)));
}
