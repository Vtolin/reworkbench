import { mapWithLimit } from "@/lib/async/pool";
import { BudgetExceededError, CallBudget } from "@/lib/research/budget";

// Claim-check runner (Phase 6): the concurrent paragraph pipeline extracted
// from app/makalah/page.tsx, UI-free. The hook (components/useMakalahRunner)
// wires section state; the classifier stays behind the injected check fn
// (default: api.makalahClaimCheck), so tests drive matching + failure paths
// with fakes. Concurrency cap: 3 (bounded throughput, order preserved).

export interface ClaimCitation {
  source_id: string;
  page: number | null;
}

export interface ClaimParagraph {
  text: string;
  citations: ClaimCitation[];
}

export interface ClaimPassage {
  source_id: string;
  page: number | null;
}

export interface ClaimVerdict {
  verdict: string;
  reason: string;
}

/**
 * Match the exact cited evidence (source + page), not the whole document:
 * sending every chunk of a cited doc as "support" makes the classifier
 * rubber-stamp unrelated paragraphs as supported. A null page on either
 * side is a wildcard. Pure (verbatim page rule).
 */
export function matchCitedPassages<P extends ClaimPassage>(
  citations: ClaimCitation[],
  passages: P[],
): P[] {
  return passages.filter((p) =>
    citations.some(
      (c) => c.source_id === p.source_id && (c.page == null || p.page == null || c.page === p.page),
    ),
  );
}

/**
 * Run the classifier over paragraphs with bounded parallelism (3) and a
 * per-run call budget (Phase 7). A failed run maps every paragraph to
 * not_supported (verbatim page behavior) — but budget exhaustion propagates
 * (explicit stop with a visible message, never silent rows).
 */
export async function executeClaimCheck<P extends ClaimPassage>(
  paragraphs: ClaimParagraph[],
  passages: P[],
  check: (paragraphText: string, cited: P[]) => Promise<ClaimVerdict>,
  opts: { budget?: CallBudget; onProgress?: (done: number, total: number) => void } = {},
): Promise<ClaimVerdict[]> {
  const budget = opts.budget ?? new CallBudget(CallBudget.claimCheckLimit());
  let done = 0;
  try {
    return await mapWithLimit(paragraphs, 3, async (para) => {
      budget.check("claim-check");
      const cited = matchCitedPassages(para.citations, passages);
      const r = await check(para.text, cited);
      done += 1;
      opts.onProgress?.(done, paragraphs.length);
      return { verdict: r.verdict, reason: r.reason };
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    return paragraphs.map(() => ({ verdict: "not_supported", reason: "Claim check call failed" }));
  }
}
