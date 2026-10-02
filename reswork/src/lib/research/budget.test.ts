import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  CLAIM_CHECK_BUDGET_DEFAULT,
  CallBudget,
  SUMMARIZE_CALL_BUDGET_DEFAULT,
} from "./budget";

describe("CallBudget", () => {
  it("allows up to the limit, then throws with counts", () => {
    const budget = new CallBudget(2);
    budget.check("map");
    budget.check("map");
    expect(budget.spent).toBe(2);
    expect(budget.remaining).toBe(0);
    expect(() => budget.check("reduce")).toThrowError(BudgetExceededError);
    try {
      budget.check("reduce");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).limit).toBe(2);
      expect(String((e as Error).message)).toContain("2 calls");
    }
  });

  it("reads env overrides, ignores garbage", () => {
    expect(CallBudget.summarizeLimit()).toBe(SUMMARIZE_CALL_BUDGET_DEFAULT);
    expect(CallBudget.claimCheckLimit()).toBe(CLAIM_CHECK_BUDGET_DEFAULT);
    process.env.SUMMARIZE_CALL_BUDGET_MAX = "7";
    try {
      expect(CallBudget.summarizeLimit()).toBe(7);
    } finally {
      delete process.env.SUMMARIZE_CALL_BUDGET_MAX;
    }
    process.env.CLAIM_CHECK_BUDGET_MAX = "nope";
    try {
      expect(CallBudget.claimCheckLimit()).toBe(CLAIM_CHECK_BUDGET_DEFAULT);
    } finally {
      delete process.env.CLAIM_CHECK_BUDGET_MAX;
    }
  });
});
