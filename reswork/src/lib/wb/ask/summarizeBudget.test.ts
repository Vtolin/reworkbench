import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, CallBudget } from "@/lib/research/budget";
import type { InferenceSelection } from "./types";

// Summarize budget (Phase 7): exhaustion aborts before the first billed
// call, surfacing through the existing error path.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({
          data: [{ content: "hello world, this is a test chunk", chunk_index: 0, page: 1, section: null }],
        });
      return chain;
    },
  }),
}));

import { summarize } from "./summarize";

function sel(): InferenceSelection {
  return {
    provider: "ollama",
    model: "m",
    cloudProvider: "openai",
    cloudModel: "",
    temperature: 0,
    numCtx: 4096,
    embedMode: "local",
  };
}

function doc() {
  return {
    id: "d1",
    title: "T",
    page_count: 1,
  } as Parameters<typeof summarize>[0];
}

describe("summarize call budget", () => {
  it("throws BudgetExceededError before any provider call when exhausted", async () => {
    const statuses: string[] = [];
    await expect(
      summarize(
        doc(),
        sel(),
        {
          onStatus: (stage: string) => {
            statuses.push(stage);
          },
        },
        { budget: new CallBudget(0) },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("counts real runs within the default ceiling", () => {
    expect(CallBudget.summarizeLimit()).toBeGreaterThan(100);
  });
});
