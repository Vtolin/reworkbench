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
        router.push("/");
        return;
      }
      // Member flow: Supabase Auth signUp, then a server-side join guarded by
      // current_members < member_limit (and absolute MAX_ALLOWED_MEMBERS=10).
      // The workspace is resolved server-side: RLS hides workspaces from
      // non-members, so a client lookup would always come back empty here.
      const supabase = createClient();
      const { data, error: signErr } = await supabase.auth.signUp({ email, password });
      if (signErr) throw signErr;
      const userId = data.user?.id;
      if (!userId) throw new Error("Sign-up succeeded but no session — ask the admin to check email-confirmation settings.");
      const join = await fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const joinData = await join.json();
      if (!join.ok) throw new Error(joinData.error ?? "Join failed");
      if (displayName) {
        await supabase.from("profiles").upsert({ id: userId, display_name: displayName });
      }
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]";

  return (
    <main className="min-h-screen w-full bg-black text-[#ececec] grid place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 justify-center">
          <div className="h-10 w-10 rounded-xl bg-white text-black grid place-items-center font-semibold">◐</div>
          <div className="text-lg font-semibold tracking-tight text-white">Research Workbench</div>
        </div>
        <h1 className="mt-8 text-2xl font-semibold text-white text-center">Register</h1>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            className={inputCls}
            placeholder="Display name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className={inputCls}
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className={inputCls}
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <label className="flex items-center gap-2 text-sm text-[#b4b4b4]">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} className="accent-white" />
            Create the workspace as admin (requires admin registration key)
          </label>
          {isAdmin && (
            <>
              <input
                className={inputCls}
                placeholder="Admin registration key"
                type="password"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                required
              />
              <input
                className={inputCls}
                placeholder="Workspace name (optional)"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
              />
            </>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 hover:bg-[#ececec]"
          >
            {busy ? "Registering…" : "Register"}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#8e8e8e] text-center">
          Have an account? <Link href="/login" className="text-white underline">Log in</Link>
        </p>
      </div>
    </main>
  );
}
