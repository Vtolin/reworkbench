// Staging RLS / authorization probe (Task B).
//
// Repeatable two-user security probe: User A (admin of workspace A),
// User B (member of workspace A, admin of workspace B), plus unauthenticated
// calls. Every case asserts ACTUAL authorization behavior (row visibility /
// row effects verified with the service-role client), not just HTTP status.
//
// Required environment (staging only — never production secrets here):
//   RLS_PROBE_URL, RLS_PROBE_ANON_KEY, RLS_PROBE_SERVICE_KEY,
//   RLS_PROBE_USER_A_EMAIL, RLS_PROBE_USER_A_PASSWORD,
//   RLS_PROBE_USER_B_EMAIL, RLS_PROBE_USER_B_PASSWORD
// The two users must already exist in the staging auth database (created
// once via the Supabase dashboard or `supabase auth`). Workspaces, documents,
// chats, credentials, and storage objects are created per-run with a unique
// suffix and torn down afterwards, so concurrent/overlapping runs do not
// interfere.
//
// Without the env above the whole suite SKIPS (local `npm test` stays green
// and offline). Run against staging with:
//   RLS_PROBE_URL=… RLS_PROBE_ANON_KEY=… RLS_PROBE_SERVICE_KEY=… \
//   RLS_PROBE_USER_A_EMAIL=… RLS_PROBE_USER_A_PASSWORD=… \
//   RLS_PROBE_USER_B_EMAIL=… RLS_PROBE_USER_B_PASSWORD=… npx vitest run src/security/rls-probe.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const env = {
  url: process.env.RLS_PROBE_URL ?? "",
  anon: process.env.RLS_PROBE_ANON_KEY ?? "",
  service: process.env.RLS_PROBE_SERVICE_KEY ?? "",
  aEmail: process.env.RLS_PROBE_USER_A_EMAIL ?? "",
  aPassword: process.env.RLS_PROBE_USER_A_PASSWORD ?? "",
  bEmail: process.env.RLS_PROBE_USER_B_EMAIL ?? "",
  bPassword: process.env.RLS_PROBE_USER_B_PASSWORD ?? "",
};
const ENABLED =
  !!env.url && !!env.anon && !!env.service && !!env.aEmail && !!env.aPassword && !!env.bEmail && !!env.bPassword;

const runTag = `probe-${Date.now().toString(36)}`;

let svc: SupabaseClient;
let userA: SupabaseClient;
let userB: SupabaseClient;
let anon: SupabaseClient;
let idA = "";
let idB = "";
let wsA = "";
let wsB = "";
let docA = ""; // approved document in wsA (uploaded by A)
let docB = ""; // approved document in wsB (uploaded by B)
let chatA = ""; // private chat in wsA owned by A

async function signInAs(email: string, password: string): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(env.url, env.anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`probe sign-in failed for ${email}: ${error?.message}`);
  return { client, userId: data.user.id };
}

describe.skipIf(!ENABLED)("staging RLS probe (User A / User B / unauthenticated)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    svc = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    ({ client: userA, userId: idA } = await signInAs(env.aEmail, env.aPassword));
    ({ client: userB, userId: idB } = await signInAs(env.bEmail, env.bPassword));

    // Workspaces: A admin of wsA; B member of wsA and admin of wsB.
    const mkWs = async (name: string): Promise<string> => {
      const { data, error } = await svc.from("workspaces").insert({ name }).select("id").single();
      if (error || !data) throw new Error(`probe workspace setup failed: ${error?.message}`);
      return (data as { id: string }).id;
    };
    wsA = await mkWs(`${runTag}-wsA`);
    wsB = await mkWs(`${runTag}-wsB`);
    await svc.from("workspace_members").insert([
      { workspace_id: wsA, user_id: idA, role: "admin", status: "active" },
      { workspace_id: wsA, user_id: idB, role: "member", status: "active" },
      { workspace_id: wsB, user_id: idB, role: "admin", status: "active" },
    ]);

    // Seeded documents (approved so member reads apply).
    const mkDoc = async (ws: string, by: string, title: string): Promise<string> => {
      const { data, error } = await svc
        .from("documents")
        .insert({ workspace_id: ws, title, status: "approved", ingestion_status: "metadata_only", uploaded_by: by })
        .select("id")
        .single();
      if (error || !data) throw new Error(`probe document setup failed: ${error?.message}`);
      return (data as { id: string }).id;
    };
    docA = await mkDoc(wsA, idA, `${runTag}-docA`);
    docB = await mkDoc(wsB, idB, `${runTag}-docB`);

    // Private chat owned by A in wsA (+ one message for the message-policy leg).
    const { data: chat, error: chatErr } = await svc
      .from("chats")
      .insert({ workspace_id: wsA, owner_id: idA, title: `${runTag}-chat`, visibility: "private" })
      .select("id")
      .single();
    if (chatErr || !chat) throw new Error(`probe chat setup failed: ${chatErr?.message}`);
    chatA = (chat as { id: string }).id;
    await svc.from("chat_messages").insert({ chat_id: chatA, role: "user", content: "probe" });

    // Credential seeds: A/openai + B/anthropic (ciphertext is opaque here —
    // RLS cares about (user_id, provider) identity, not payload validity).
    await svc.from("ai_credentials").upsert([
      { user_id: idA, provider: "openai", ciphertext: "probe", iv: "probe" },
      { user_id: idB, provider: "anthropic", ciphertext: "probe", iv: "probe" },
    ]);
  });

  afterAll(async () => {
    if (!svc) return;
    // Storage cleanup first (no FK cascade into storage.objects).
    await svc.storage.from("documents").remove([`${wsA}/${runTag}.txt`, `${wsB}/${runTag}.txt`]);
    // Workspace cascade removes documents, chats, members, trail, chunks…
    if (wsA) await svc.from("workspaces").delete().eq("id", wsA);
    if (wsB) await svc.from("workspaces").delete().eq("id", wsB);
    // Credentials are user-scoped (no workspace cascade): remove probe rows.
    if (idA) await svc.from("ai_credentials").delete().eq("user_id", idA).eq("provider", "openai");
    if (idB) await svc.from("ai_credentials").delete().eq("user_id", idB).eq("provider", "anthropic");
  });

  it("unauthenticated callers see no workspace rows", async () => {
    const { data, error } = await anon.from("documents").select("id").limit(5);
    expect(error?.message ?? "").not.toMatch(/probe/i);
    expect(data ?? []).toEqual([]);
  });

  it("User A reads own workspace document but not User B's", async () => {
    const own = await userA.from("documents").select("id").eq("id", docA);
    expect((own.data ?? []).map((d) => d.id)).toContain(docA);
    const other = await userA.from("documents").select("id").eq("id", docB);
    expect(other.data ?? []).toEqual([]);
  });

  it("User A INSERT into own workspace succeeds; into User B's workspace is rejected with no row effect", async () => {
    const ok = await userA.from("documents").insert({
      workspace_id: wsA, title: `${runTag}-a-own`, status: "pending", uploaded_by: idA,
    }).select("id").single();
    expect(ok.error).toBeNull();
    const bad = await userA.from("documents").insert({
      workspace_id: wsB, title: `${runTag}-a-cross`, status: "pending", uploaded_by: idA,
    });
    expect(bad.error).not.toBeNull();
    const leaked = await svc.from("documents").select("id").eq("workspace_id", wsB).ilike("title", `${runTag}-a-cross`);
    expect(leaked.data ?? []).toEqual([]);
  });

  it("User A UPDATE/DELETE of User B's document is rejected and leaves the row unchanged", async () => {
    const before = await svc.from("documents").select("title").eq("id", docB).single();
    const upd = await userA.from("documents").update({ title: `${runTag}-hijacked` }).eq("id", docB);
    expect(upd.error ?? (upd.data as unknown[] | null)?.length === 0 ? "blocked" : null).toBeTruthy();
    const del = await userA.from("documents").delete().eq("id", docB);
    expect(del.error ?? (del.data as unknown[] | null)?.length === 0 ? "blocked" : null).toBeTruthy();
    const after = await svc.from("documents").select("title").eq("id", docB).single();
    expect(after.data).toEqual(before.data);
    expect((await svc.from("documents").select("id").eq("id", docB).single()).data).not.toBeNull();
  });

  it("member (User B) cannot perform admin operations; admin (User A) can", async () => {
    // B tries to approve A's pending document -> must fail (non-admin status flip).
    const pending = await svc.from("documents")
      .insert({ workspace_id: wsA, title: `${runTag}-to-approve`, status: "pending", uploaded_by: idA })
      .select("id").single();
    const pendingId = (pending.data as { id: string }).id;
    const flip = await userB.from("documents").update({ status: "approved" }).eq("id", pendingId);
    expect(flip.error).not.toBeNull();
    expect((await svc.from("documents").select("status").eq("id", pendingId).single()).data).toMatchObject({ status: "pending" });
    // B tries admin-only delete -> must fail and the row must survive.
    const del = await userB.from("documents").delete().eq("id", pendingId);
    expect(del.error ?? (del.data as unknown[] | null)?.length === 0 ? "blocked" : null).toBeTruthy();
    expect((await svc.from("documents").select("id").eq("id", pendingId).single()).data).not.toBeNull();
    // A (admin) deletes it -> intended admin operation succeeds.
    const adminDel = await userA.from("documents").delete().eq("id", pendingId);
    expect(adminDel.error).toBeNull();
    expect((await svc.from("documents").select("id").eq("id", pendingId).maybeSingle()).data).toBeNull();
  });

  it("credential rows are strictly owner-visible and owner-mutable", async () => {
    const aRows = await userA.from("ai_credentials").select("provider");
    expect((aRows.data ?? []).map((r) => r.provider)).toEqual(["openai"]);
    // B must not see A's row even when asking for it directly.
    const cross = await userB.from("ai_credentials").select("provider").eq("user_id", idA);
    expect(cross.data ?? []).toEqual([]);
    // B must not overwrite or remove A's provider row.
    const upd = await userB.from("ai_credentials").update({ ciphertext: "hijacked" }).eq("user_id", idA).eq("provider", "openai");
    expect(upd.error ?? (upd.data as unknown[] | null)?.length === 0 ? "blocked" : null).toBeTruthy();
    const del = await userB.from("ai_credentials").delete().eq("user_id", idA).eq("provider", "openai");
    expect(del.error ?? (del.data as unknown[] | null)?.length === 0 ? "blocked" : null).toBeTruthy();
    const intact = await svc.from("ai_credentials").select("ciphertext").eq("user_id", idA).eq("provider", "openai").single();
    expect(intact.data).toMatchObject({ ciphertext: "probe" });
    // B manages their own provider row (multi-provider cardinality leg).
    const own = await userB.from("ai_credentials").select("provider").eq("user_id", idB);
    expect((own.data ?? []).map((r) => r.provider)).toEqual(["anthropic"]);
  });

  // Requires migration 0008 (fails on 0001–0007: message SELECT was
  // membership-only and leaked private chats to any member with the id).
  it("private chat messages are visible to the owner but not to a workspace member", async () => {
    const owner = await userA.from("chat_messages").select("id").eq("chat_id", chatA);
    expect((owner.data ?? []).length).toBeGreaterThan(0);
    const member = await userB.from("chat_messages").select("id").eq("chat_id", chatA);
    expect(member.data ?? []).toEqual([]);
  });

  it("storage: own prefix writable/readable, other workspace prefix and traversal contained", async () => {
    const payload = new Blob(["probe"], { type: "text/plain" });
    const ownPath = `${wsA}/${runTag}.txt`;
    expect((await userA.storage.from("documents").upload(ownPath, payload, { upsert: true })).error).toBeNull();
    // Cross-workspace write must fail.
    const cross = await userA.storage.from("documents").upload(`${wsB}/${runTag}.txt`, payload, { upsert: true });
    expect(cross.error).not.toBeNull();
    // Another workspace's member cannot download A's object…
    expect((await userB.storage.from("documents").download(ownPath)).error).not.toBeNull();
    // …and a traversal-styled path must not become a readable alias for it.
    const traversal = await userA.storage.from("documents").upload(`${wsA}/../${wsB}/${runTag}.txt`, payload, { upsert: true });
    if (!traversal.error && traversal.data?.path) {
      const leaked = await userB.storage.from("documents").download(traversal.data.path);
      expect(leaked.error ?? leaked.data === null ? "blocked" : null).toBeTruthy();
      await svc.storage.from("documents").remove([traversal.data.path]);
    }
  });
});
