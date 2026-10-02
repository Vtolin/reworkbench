// Per-run AI call budgets (Phase 7).
//
// Long pipelines (summarize map→reduce, makalah claim-check) fan out to one
// billed call per unit of work. A CallBudget caps the calls per run: every
// provider.chat goes through check() first, and exhaustion throws
// BudgetExceededError into the existing error path (visible progress +
// message, no silent truncation). Defaults are generous ceilings (a 100-chunk
// doc needs ~107 summarize calls), not targets — override via env.
// Billed calls are still never retried (see lib/async/net policy).

/** Generous ceiling: ~100-chunk doc ≈ classify(1) + map(100) + reduce(~5) + synth(1). */
export const SUMMARIZE_CALL_BUDGET_DEFAULT = 250;
/** Generous ceiling for long sections with many paragraphs. */
export const CLAIM_CHECK_BUDGET_DEFAULT = 200;

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly step?: string,
  ) {
    super(
      `Call budget exceeded (${limit} calls${step ? ` at ${step}` : ""}) — narrow the scope or raise the budget.`,
    );
    this.name = "BudgetExceededError";
  }
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export class CallBudget {
  private used = 0;

  constructor(public readonly limit: number) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Consume one call; throws BudgetExceededError at the ceiling. */
  check(step?: string): void {
    if (this.used >= this.limit) throw new BudgetExceededError(this.limit, step);
    this.used += 1;
  }

  static summarizeLimit(): number {
    return envPositiveInt("SUMMARIZE_CALL_BUDGET_MAX", SUMMARIZE_CALL_BUDGET_DEFAULT);
  }

  static claimCheckLimit(): number {
    return envPositiveInt("CLAIM_CHECK_BUDGET_MAX", CLAIM_CHECK_BUDGET_DEFAULT);
  }
}
