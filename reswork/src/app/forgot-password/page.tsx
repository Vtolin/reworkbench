"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { requestPasswordReset } from "@/lib/auth/passwordReset";

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const expiredLink = searchParams.get("error") === "invalid_or_expired_link";

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(
    expiredLink
      ? "That password reset link is invalid or has expired. Request a new one below."
      : null,
  );
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const result = await requestPasswordReset(createClient(), email, origin);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSentTo(email.trim());
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <div className="mt-6 rounded-2xl border border-[#2f2f2f] bg-[#141414] p-5 text-center space-y-4">
        <div className="mx-auto h-10 w-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 grid place-items-center text-base">
          ✓
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-medium text-white">Check your email</h2>
          <p className="text-xs leading-relaxed text-[#8e8e8e]">
            If an account exists for <span className="text-white font-medium">{sentTo}</span>, we&apos;ve sent a password reset link. Check your inbox and spam folder.
          </p>
        </div>
        <div className="pt-2 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setError(null);
            }}
            className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-4 py-2 text-xs font-medium text-[#ececec] hover:bg-[#212121]"
          >
            Send to a different email
          </button>
          <Link
            href="/login"
            className="w-full rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-black hover:bg-[#ececec] inline-block"
          >
            Back to log in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="mt-2 text-center text-sm text-[#8e8e8e]">
        Enter the email associated with your account and we&apos;ll send a link to reset your password.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]"
          placeholder="Email"
          aria-label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 hover:bg-[#ececec]"
        >
          {busy ? "Sending reset link…" : "Send reset link"}
        </button>
      </form>
      <p className="mt-4 text-sm text-[#8e8e8e] text-center">
        Remembered your password?{" "}
        <Link href="/login" className="text-white underline">
          Log in
        </Link>
      </p>
    </>
  );
}

export default function ForgotPasswordPage() {
  return (
    <main className="min-h-screen w-full bg-black text-[#ececec] grid place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 justify-center">
          <div className="h-10 w-10 rounded-xl bg-white text-black grid place-items-center font-semibold">
            ◐
          </div>
          <div className="text-lg font-semibold tracking-tight text-white">
            Research Workbench
          </div>
        </div>
        <h1 className="mt-8 text-2xl font-semibold text-white text-center">
          Reset your password
        </h1>
        <Suspense
          fallback={
            <div className="mt-6 text-center text-sm text-[#8e8e8e]">Loading…</div>
          }
        >
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
