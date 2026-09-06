"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      // Kicked members have sessions invalidated; surface a clear message.
      setError(error.message);
      return;
    }
    router.push("/dashboard");
  };

  return (
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold text-neutral-100">Log in</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
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
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-neutral-400">
        New here? <Link href="/register" className="underline">Register</Link> · Admin?{" "}
        <Link href="/admin" className="underline">Admin dashboard</Link>
      </p>
    </main>
  );
}
