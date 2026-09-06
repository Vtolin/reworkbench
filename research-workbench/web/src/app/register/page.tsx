"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isAdmin) {
        // Admin bootstrap: server creates user + workspace + membership.
        const res = await fetch("/api/auth/register-admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, admin_key: adminKey, workspaceName: workspaceName || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Admin registration failed");
        // Now sign in as the new admin.
        const supabase = createClient();
        const { error: signErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signErr) throw signErr;
        router.push("/dashboard");
        return;
      }
      // Member flow: Supabase Auth signUp, then server-side join guarded by
      // current_members < member_limit (and absolute MAX_ALLOWED_MEMBERS=10).
      const supabase = createClient();
      const { data, error: signErr } = await supabase.auth.signUp({ email, password });
      if (signErr) throw signErr;
      const userId = data.user?.id;
      if (!userId) throw new Error("Sign-up succeeded but no session — check email confirmation settings.");
      // Single-workspace MVP: join the first workspace found.
      const { data: workspaces } = await supabase.from("workspaces").select("id").limit(1);
      const workspaceId = workspaces?.[0]?.id;
      if (!workspaceId) throw new Error("No workspace exists yet — ask the admin to register first.");
      const join = await fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, userId }),
      });
      const joinData = await join.json();
      if (!join.ok) throw new Error(joinData.error ?? "Join failed");
      if (displayName) {
        await supabase.from("profiles").upsert({ id: userId, display_name: displayName });
      }
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold text-neutral-100">Register</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          placeholder="Display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Create the workspace as admin (requires ADMIN_REGISTRATION_KEY)
        </label>
        {isAdmin && (
          <>
            <input
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              placeholder="Admin registration key"
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              required
            />
            <input
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
              placeholder="Workspace name (optional)"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
            />
          </>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "Registering…" : "Register"}
        </button>
      </form>
      <p className="mt-4 text-sm text-neutral-400">
        Have an account? <Link href="/login" className="underline">Log in</Link>
      </p>
    </main>
  );
}
