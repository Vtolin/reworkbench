import { describe, expect, it } from "vitest";
import { resolveInitialDocumentStatus, shouldAutoApproveWorkspace, type WorkspacePolicyClient } from "./autoApprove";

function mockClient(result: { data: unknown; error: { message: string } | null }): WorkspacePolicyClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  };
}

describe("workspace auto-approve helpers", () => {
  it("resolves approved only when auto-approve is enabled", () => {
    expect(resolveInitialDocumentStatus(false)).toBe("pending");
    expect(resolveInitialDocumentStatus(true)).toBe("approved");
  });

  it("reads auto_approve_uploads safely and defaults false on error or missing column", async () => {
    expect(await shouldAutoApproveWorkspace(mockClient({ data: { auto_approve_uploads: true }, error: null }), "ws1")).toBe(true);
    expect(await shouldAutoApproveWorkspace(mockClient({ data: { auto_approve_uploads: false }, error: null }), "ws1")).toBe(false);
    expect(await shouldAutoApproveWorkspace(mockClient({ data: null, error: { message: "column missing" } }), "ws1")).toBe(false);
  });
});
