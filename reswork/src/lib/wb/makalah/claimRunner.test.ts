import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, CallBudget } from "@/lib/research/budget";
import { executeClaimCheck, matchCitedPassages } from "./claimRunner";

describe("matchCitedPassages", () => {
  const passages = [
    { source_id: "s1", page: 2 },
    { source_id: "s1", page: 5 },
    { source_id: "s2", page: null },
  ];

  it("matches exact source+page pairs", () => {
    expect(matchCitedPassages([{ source_id: "s1", page: 2 }], passages)).toEqual([
      { source_id: "s1", page: 2 },
    ]);
  });

  it("treats null pages as wildcards on either side", () => {
    expect(matchCitedPassages([{ source_id: "s1", page: null }], passages).length).toBe(2);
    expect(matchCitedPassages([{ source_id: "s2", page: 9 }], passages)).toEqual([
      { source_id: "s2", page: null },
    ]);
  });

  it("never matches across sources", () => {
    expect(matchCitedPassages([{ source_id: "s9", page: null }], passages)).toEqual([]);
  });
});

describe("executeClaimCheck", () => {
  const paragraphs = [
    { text: "p1", citations: [{ source_id: "s1", page: 2 }] },
    { text: "p2", citations: [{ source_id: "s2", page: null }] },
  ];
  const passages = [
    { source_id: "s1", page: 2 },
    { source_id: "s1", page: 5 },
    { source_id: "s2", page: 9 },
  ];

  it("checks each paragraph against exactly its cited evidence, in order", async () => {
    const seen: Array<{ text: string; cited: unknown }> = [];
    const check = vi.fn(async (text: string, cited: unknown) => {
      seen.push({ text, cited });
      return { verdict: "supported", reason: "ok" };
    });
    const out = await executeClaimCheck(paragraphs, passages, check);
    expect(out).toEqual([
      { verdict: "supported", reason: "ok" },
      { verdict: "supported", reason: "ok" },
    ]);
    expect(seen).toEqual([
      { text: "p1", cited: [{ source_id: "s1", page: 2 }] },
      { text: "p2", cited: [{ source_id: "s2", page: 9 }] },
    ]);
  });

  it("maps a failed run to not_supported rows (never throws)", async () => {
    const out = await executeClaimCheck(paragraphs, passages, async () => {
      throw new Error("classifier down");
    });
    expect(out).toEqual([
      { verdict: "not_supported", reason: "Claim check call failed" },
      { verdict: "not_supported", reason: "Claim check call failed" },
    ]);
  });

  it("propagates budget exhaustion instead of masking it (explicit stop)", async () => {
    const check = vi.fn(async () => ({ verdict: "supported", reason: "ok" }));
    await expect(
      executeClaimCheck(paragraphs, passages, check, { budget: new CallBudget(1) }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // Exactly one billed call happened before the ceiling hit.
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("reports progress per completed paragraph", async () => {
    const seen: Array<[number, number]> = [];
    await executeClaimCheck(paragraphs, passages, async () => ({ verdict: "supported", reason: "ok" }), {
      onProgress: (done, total) => {
        seen.push([done, total]);
      },
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
