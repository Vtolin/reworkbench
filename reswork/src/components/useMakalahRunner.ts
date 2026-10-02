"use client";

import { api } from "@/lib/api";
import type { SectionParagraph, SectionPassage } from "@/lib/wb/makalah/types";
import type { CallBudget } from "@/lib/research/budget";
import {
  executeClaimCheck,
  type ClaimVerdict,
} from "@/lib/wb/makalah/claimRunner";

// Claim-check runner (Phase 6): the concurrent paragraph pipeline extracted
// from app/makalah/page.tsx. Section state stays in the page; the classifier
// is injectable for tests (see claimRunner.test.ts).

export interface ClaimSection {
  output: { paragraphs: SectionParagraph[] } | null;
  passages: SectionPassage[];
  claimBusy: boolean;
}

export function useMakalahRunner(deps: {
  getSection: (key: string) => ClaimSection | undefined;
  setSec: (
    key: string,
    patch: {
      claims?: Array<{ verdict: string; reason: string }> | null;
      claimBusy?: boolean;
      claimProgress?: { current: number; total: number } | null;
    },
  ) => void;
  claimCheck?: (paragraphText: string, cited: SectionPassage[]) => Promise<ClaimVerdict>;
  budget?: CallBudget;
}) {
  const runClaimCheck = async (key: string): Promise<void> => {
    const st = deps.getSection(key);
    if (!st?.output || st.claimBusy) return;
    deps.setSec(key, { claimBusy: true, claimProgress: null });
    try {
      const results = await executeClaimCheck(
        st.output.paragraphs,
        st.passages,
        deps.claimCheck ?? api.makalahClaimCheck,
        {
          budget: deps.budget,
          onProgress: (done, total) => deps.setSec(key, { claimProgress: { current: done, total } }),
        },
      );
      deps.setSec(key, { claims: results, claimProgress: null });
    } finally {
      deps.setSec(key, { claimBusy: false });
    }
  };

  return { runClaimCheck };
}
