import type { createClient } from "@/lib/supabase/client";

type BrowserClient = ReturnType<typeof createClient>;

export interface WorkspacePolicyClient {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export function resolveInitialDocumentStatus(autoApproveEnabled: boolean): "approved" | "pending" {
  return autoApproveEnabled ? "approved" : "pending";
}

export async function shouldAutoApproveWorkspace(
  sb: BrowserClient | WorkspacePolicyClient,
  workspaceId: string
): Promise<boolean> {
  try {
    const client = sb as WorkspacePolicyClient;
    const { data, error } = await client
      .from("workspaces")
      .select("auto_approve_uploads")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error || !data) return false;
    return Boolean((data as { auto_approve_uploads?: boolean }).auto_approve_uploads);
  } catch {
    return false;
  }
}
