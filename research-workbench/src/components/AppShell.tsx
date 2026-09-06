"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import MobileShell from "@/components/MobileShell";
import { RealtimeToasts } from "@/components/RealtimeToasts";
import { useSession } from "@/contexts/SessionContext";
import { createClient } from "@/lib/supabase/client";
import { useState } from "react";

function JoinGate({ onJoined }: { onJoined: () => void }) {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Join failed");
      onJoined();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Join failed");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    window.location.href = "/login";
  };

  return (
    <main className="min-h-screen w-full bg-black text-[#ececec] grid place-items-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="h-12 w-12 mx-auto rounded-2xl bg-white text-black grid place-items-center text-xl">◐</div>
        <h1 className="mt-4 text-xl font-semibold text-white">No workspace access</h1>
        <p className="mt-2 text-sm text-[#8e8e8e]">
          Signed in as {user?.email}, but this account isn&apos;t a member of any workspace yet.
        </p>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          onClick={join}
          disabled={busy}
          className="mt-6 w-full rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black disabled:opacity-50 hover:bg-[#ececec]"
        >
          {busy ? "Joining…" : "Join workspace"}
        </button>
        <button onClick={signOut} className="mt-3 text-sm text-[#8e8e8e] hover:text-white underline">
          Sign out
        </button>
      </div>
    </main>
  );
}

const PUBLIC_ROUTES = ["/login", "/register"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { user, workspace, loading } = useSession();
  const isPublic = PUBLIC_ROUTES.some((r) => path === r || path.startsWith(r + "/"));

  useEffect(() => {
    if (!loading && !user && !isPublic) router.push("/login");
  }, [loading, user, isPublic, router]);

  if (isPublic) return <>{children}</>;
  if (loading || !user) {
    return <div className="min-h-screen grid place-items-center text-sm text-[#8e8e8e] bg-black">Loading…</div>;
  }
  if (!workspace) {
    // Signed in but no active membership (e.g. joined before the workspace
    // existed, or was kicked). Offer a self-service join instead of a dead end.
    return <JoinGate onJoined={() => window.location.reload()} />;
  }
  return (
    <MobileShell>
      <RealtimeToasts />
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden bg-black">
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </MobileShell>
  );
}
