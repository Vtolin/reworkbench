"use client";

import { useState } from "react";
import { confirmIngest, type ConfirmedDocument, type ConfirmInput, type IngestPreview } from "@/lib/wb/ingest";
import {
  executeIngestFlow,
  type IngestCandidate,
  type IngestRunnerEdit,
  type IngestRunResult,
} from "@/lib/wb/ingestRunner";

// Ingest-flow runner hook (Phase 6): thin state shell over
// executeIngestFlow (tested with fakes in ingestRunner.test.ts).
// UploadFlow adoption is deliberately deferred (no UploadFlow changes beyond
// typing this phase) — wire it when the flow is next touched.
export function useIngestRunner(deps: {
  confirm?: (input: ConfirmInput) => Promise<{ document: ConfirmedDocument; indexingError: string | null }>;
  onDone?: () => void;
} = {}) {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestRunResult | null>(null);

  const run = async (input: {
    file: File;
    preview: IngestPreview;
    edit: IngestRunnerEdit;
    candidate: IngestCandidate | null;
    embedMode: "local" | "server";
  }): Promise<void> => {
    if (!input.preview || !input.file) return;
    setLoading(true);
    setError(null);
    await executeIngestFlow(deps.confirm ?? confirmIngest, input, {
      phase: setPhase,
      done: (r) => {
        setResult(r);
        deps.onDone?.();
      },
      failed: setError,
    });
    setLoading(false);
  };

  return { loading, phase, error, result, run };
}
