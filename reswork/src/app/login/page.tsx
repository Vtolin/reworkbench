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
    router.push("/");
  };

  return (
    <main className="min-h-screen w-full bg-black text-[#ececec] grid place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 justify-center">
          <div className="h-10 w-10 rounded-xl bg-white text-black grid place-items-center font-semibold">◐</div>
          <div className="text-lg font-semibold tracking-tight text-white">Research Workbench</div>
        </div>
        <h1 className="mt-8 text-2xl font-semibold text-white text-center">Log in</h1>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 hover:bg-[#ececec]"
          >
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#8e8e8e] text-center">
          New here? <Link href="/register" className="text-white underline">Register</Link>
        </p>
      </div>
    </main>
  );
}
