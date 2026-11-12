"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  MIN_PASSWORD_LENGTH,
  completePasswordUpdate,
} from "@/lib/auth/passwordReset";

type RecoveryStage = "verifying" | "ready" | "invalid" | "updated";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const codeParam = searchParams.get("code");
  const tokenHashParam = searchParams.get("token_hash");
  const typeParam = searchParams.get("type");

  const [stage, setStage] = useState<RecoveryStage>("verifying");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (
        (event === "PASSWORD_RECOVERY" ||
          event === "SIGNED_IN" ||
          event === "INITIAL_SESSION") &&
        session?.user
      ) {
        setStage((prev) => (prev === "updated" ? prev : "ready"));
      }
    });

    (async () => {
      try {
        // Support direct email links to /reset-password?code=... or ?token_hash=...
        // in addition to links routed through /api/auth/callback.
        if (codeParam) {
          const { error: codeErr } = await supabase.auth.exchangeCodeForSession(
            codeParam,
          );
          if (cancelled) return;
          if (codeErr) {
            setStage("invalid");
            return;
          }
        } else if (tokenHashParam) {
          const { error: otpErr } = await supabase.auth.verifyOtp({
            token_hash: tokenHashParam,
            type: typeParam === "signup" || typeParam === "email" ? typeParam : "recovery",
          });
          if (cancelled) return;
          if (otpErr) {
            setStage("invalid");
            return;
          }
        }

        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        if (data.user) {
          setStage((prev) => (prev === "updated" ? prev : "ready"));
        } else {
          setStage("invalid");
        }
      } catch {
        if (!cancelled) setStage("invalid");
      }
    })();

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [codeParam, tokenHashParam, typeParam]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const result = await completePasswordUpdate(
        supabase,
        password,
        confirmPassword,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStage("updated");
      setTimeout(() => {
        router.push("/");
      }, 1800);
    } finally {
      setBusy(false);
    }
  };

  if (stage === "verifying") {
    return (
      <div className="mt-6 text-center text-sm text-[#8e8e8e]">
        Verifying your recovery link…
      </div>
    );
  }

  if (stage === "invalid") {
    return (
      <div className="mt-6 rounded-2xl border border-[#2f2f2f] bg-[#141414] p-5 text-center space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-base font-medium text-white">
            Recovery link expired or invalid
          </h2>
          <p className="text-xs leading-relaxed text-[#8e8e8e]">
            Password reset links are single-use and expire after a short window. Request a fresh link to continue.
          </p>
        </div>
        <div className="pt-2 flex flex-col gap-2">
          <Link
            href="/forgot-password"
            className="w-full rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-black hover:bg-[#ececec] inline-block"
          >
            Request new reset link
          </Link>
          <Link
            href="/login"
            className="w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-4 py-2 text-xs font-medium text-[#ececec] hover:bg-[#212121] inline-block"
          >
            Back to log in
          </Link>
        </div>
      </div>
    );
  }

  if (stage === "updated") {
    return (
      <div className="mt-6 rounded-2xl border border-[#2f2f2f] bg-[#141414] p-5 text-center space-y-4">
        <div className="mx-auto h-10 w-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 grid place-items-center text-base">
          ✓
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-medium text-white">
            Password updated
          </h2>
          <p className="text-xs leading-relaxed text-[#8e8e8e]">
            Your new password has been saved. Redirecting you to the workbench…
          </p>
        </div>
        <Link
          href="/"
          className="w-full rounded-xl bg-white px-4 py-2.5 text-xs font-medium text-black hover:bg-[#ececec] inline-block"
        >
          Continue to workbench
        </Link>
      </div>
    );
  }

  const inputCls =
    "w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2.5 text-sm text-white placeholder:text-[#5f5f5f] outline-none focus:border-[#404040]";

  return (
    <>
      <p className="mt-2 text-center text-sm text-[#8e8e8e]">
        Choose a new password for your account (at least {MIN_PASSWORD_LENGTH} characters).
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          className={inputCls}
          placeholder={`New password (min. ${MIN_PASSWORD_LENGTH} characters)`}
          aria-label="New password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <input
          className={inputCls}
          placeholder="Confirm new password"
          aria-label="Confirm new password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 hover:bg-[#ececec]"
        >
          {busy ? "Updating password…" : "Update password"}
        </button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
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
          Set a new password
        </h1>
        <Suspense
          fallback={
            <div className="mt-6 text-center text-sm text-[#8e8e8e]">
              Verifying your recovery link…
            </div>
          }
        >
          <ResetPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
