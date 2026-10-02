import { NextResponse } from "next/server";
import type { createServerSupabase } from "@/lib/supabase/server";

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

// Server-only API auth guards (infrastructure, not domain).
// Extracted from the proven pattern in
// src/app/api/workspaces/kick/route.ts so gated routes share one
// implementation. RLS remains the enforcement backstop — these checks are
// defense in depth and produce explicit 401/403 instead of relying solely
// on Postgres error mapping.
//
// Split deliberately: I/O helpers use the real server-client type (narrow
// structural interfaces fight Supabase's untyped generics and produce
// deep-instantiation failures), while every *decision* is a pure function
// over already-fetched values — those are what the unit tests pin.

// -- I/O ---------------------------------------------------------------

/** Caller id from the session cookie, or null when anonymous. */
export async function getCallerId(supabase: ServerSupabase): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Active membership role in a workspace, or null when not a member. */
export async function getWorkspaceRole(
  supabase: ServerSupabase,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const row: unknown = data;
  if (typeof row !== "object" || row === null || !("role" in row)) return null;
  const role: unknown = row.role;
  return typeof role === "string" ? role : null;
}

// -- Pure decisions (unit-tested) ---------------------------------------

export function requireUserId(userId: string | null): { userId: string } | { error: NextResponse } {
  if (!userId) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { userId };
}

/** Any active membership (admin or member). Unknown roles fail closed. */
export function requireMemberRole(role: string | null): { ok: true } | { error: NextResponse } {
  if (role !== "admin" && role !== "member") {
    return { error: NextResponse.json({ error: "Workspace access required" }, { status: 403 }) };
  }
  return { ok: true };
}

export function requireAdminRole(role: string | null): { ok: true } | { error: NextResponse } {
  if (role !== "admin") {
    return { error: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { ok: true };
}

// -- Composed guards (what routes call) ----------------------------------

export async function requireAuthenticatedUser(
  supabase: ServerSupabase,
): Promise<{ userId: string } | { error: NextResponse }> {
  return requireUserId(await getCallerId(supabase));
}

export async function requireWorkspaceMember(
  supabase: ServerSupabase,
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { error: NextResponse }> {
  return requireMemberRole(await getWorkspaceRole(supabase, workspaceId, userId));
}

export async function requireWorkspaceAdmin(
  supabase: ServerSupabase,
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { error: NextResponse }> {
  return requireAdminRole(await getWorkspaceRole(supabase, workspaceId, userId));
}
