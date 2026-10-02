import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/app/api/_lib/rateLimit";
import { getRequestId, withRequestId } from "@/app/api/_lib/request";
import { logEvent } from "@/lib/observability/log";

// POST /api/auth/register-admin {email, password, admin_key}
// On ADMIN_REGISTRATION_KEY match: create Supabase user → workspace → admin membership.
// Errors are deliberately generic: distinguishing "bad key" from
// "email taken" would let anonymous callers enumerate accounts and
// brute-force the key with an oracle.
//
// Safety (Phase 3):
// - Per-IP rate limit runs BEFORE the key check, so the key cannot be
//   brute-forced at scale (no oracle, no throughput).
// - Bootstrap is atomic via compensating deletes in reverse order: any step
//   that fails removes what earlier steps created (member → workspace → auth
//   user), each logged. Retries therefore start clean (same email retries
//   fail at createUser with the same generic 400, never orphan rows).
function keyMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const GENERIC_FAIL = "Registration failed";

export async function POST(req: Request) {
  const expected = process.env.ADMIN_REGISTRATION_KEY;
  if (!expected) {
    console.error("register-admin called without ADMIN_REGISTRATION_KEY configured");
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 500 });
  }
  const requestId = getRequestId(req); // Phase 7: every logEvent below carries this.
  const limited = await enforceRateLimit(req, "register-admin", { perIp: true, requestId });
  if (limited) return withRequestId(limited, requestId);
  let body: { email?: string; password?: string; admin_key?: string; workspaceName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!keyMatches(body.admin_key, expected)) {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 403 });
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }
  const supabase = createServiceSupabase();

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 400 });
  }
  const userId = created.user.id;

  const compensate = async (step: string, fn: () => Promise<{ error?: { message: string } | null }>): Promise<void> => {
    try {
      const { error } = await fn();
      // IDs only — never email/passwords (redact() is the backstop).
      logEvent(error ? "error" : "info", "register_admin.compensate", { requestId, step, userId, ok: !error });
    } catch {
      logEvent("error", "register_admin.compensate", { requestId, step, userId, ok: false });
    }
  };

  const { data: workspace, error: wsErr } = await supabase
    .from("workspaces")
    .insert({
      name: body.workspaceName ?? process.env.DEFAULT_WORKSPACE_NAME ?? "Research Workbench",
      admin_id: userId,
    })
    .select("id")
    .single();
  if (wsErr || !workspace) {
    console.error("register-admin workspace creation failed:", wsErr?.message ?? "unknown");
    await compensate("delete-auth-user", () => supabase.auth.admin.deleteUser(userId));
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 500 });
  }
  const workspaceId = (workspace as { id: string }).id;

  const { error: memberErr } = await supabase.from("workspace_members").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role: "admin",
    status: "active",
  });
  if (memberErr) {
    console.error("register-admin membership creation failed:", memberErr.message);
    await compensate("delete-workspace", async () => {
      const { error } = await supabase.from("workspaces").delete().eq("id", workspaceId);
      return { error };
    });
    await compensate("delete-auth-user", () => supabase.auth.admin.deleteUser(userId));
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 500 });
  }

  const { error: profileErr } = await supabase.from("profiles").upsert({ id: userId });
  if (profileErr) {
    console.error("register-admin profile creation failed:", profileErr.message);
    await compensate("delete-member", async () => {
      const { error } = await supabase
        .from("workspace_members")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId);
      return { error };
    });
    await compensate("delete-workspace", async () => {
      const { error } = await supabase.from("workspaces").delete().eq("id", workspaceId);
      return { error };
    });
    await compensate("delete-auth-user", () => supabase.auth.admin.deleteUser(userId));
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 500 });
  }
  return NextResponse.json({ ok: true, workspaceId, userId });
}
