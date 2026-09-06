"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import MobileShell from "@/components/MobileShell";
import { RealtimeToasts } from "@/components/RealtimeToasts";
import { useSession } from "@/contexts/SessionContext";

const PUBLIC_ROUTES = ["/login", "/register"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { user, loading } = useSession();
  const isPublic = PUBLIC_ROUTES.some((r) => path === r || path.startsWith(r + "/"));

  useEffect(() => {
    if (!loading && !user && !isPublic) router.push("/login");
  }, [loading, user, isPublic, router]);

  if (isPublic) return <>{children}</>;
  if (loading || !user) {
    return <div className="min-h-screen grid place-items-center text-sm text-[#8e8e8e] bg-black">Loading…</div>;
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
