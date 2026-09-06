"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

interface WorkspaceInfo {
  id: string;
  name: string;
  role: "admin" | "member";
  member_limit: number;
}

const Ctx = createContext<{
  user: User | null;
  workspace: WorkspaceInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
}>({ user: null, workspace: null, loading: true, refresh: async () => {} });

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    setUser(data.user);
    if (data.user) {
      const { data: membership } = await supabase
        .from("workspace_members")
        .select("role, workspace_id, workspaces(id, name, member_limit)")
        .eq("user_id", data.user.id)
        .eq("status", "active")
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (membership) {
        const ws = membership.workspaces as unknown as {
          id: string;
          name: string;
          member_limit: number;
        };
        setWorkspace({
          id: ws.id,
          name: ws.name,
          role: membership.role as "admin" | "member",
          member_limit: ws.member_limit,
        });
      } else {
        setWorkspace(null);
      }
    } else {
      setWorkspace(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const supabase = createClient();
    const { data: sub } = supabase.auth.onAuthStateChange(() => refresh());
    return () => sub.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={{ user, workspace, loading, refresh }}>{children}</Ctx.Provider>;
}
