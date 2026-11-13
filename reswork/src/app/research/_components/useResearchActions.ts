"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { SummaryStats } from "@/lib/api/research";
import type { StoredChatMessage } from "@/contexts/ChatContext";
import { toUserMessage } from "@/lib/errors";
import { downloadBlob, downloadText } from "@/lib/browser/download";
import { toggleId } from "./ids";
import type { MatrixRow, PipelineStatus, TimedStatus } from "./types";

interface ActionsDeps {
  docs: Array<{ id: string; original_filename: string }>;
  addMessage: (msg: StoredChatMessage) => void;
  setAutoFollow: (value: boolean) => void;
}

function assistantId(): string {
  return "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Compare / summarize / matrix / synthesis state machines for the research
 * page. Ask streaming stays in useAskStream; this hook only owns the
 * non-streaming pipelines and their export affordances.
 */
export function useResearchActions({ docs, addMessage, setAutoFollow }: ActionsDeps) {
  // Compare -----------------------------------------------------------------
  const [compareQ, setCompareQ] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);

  const doCompare = async () => {
    if (compareIds.length < 2 || !compareQ.trim() || compareLoading) return;
    const labels = compareIds.map((id) => docs.find((d) => d.id === id)?.original_filename).join(", ");
    addMessage({
      id: Date.now().toString(),
      role: "user",
      content: `[Compare: ${labels}] ${compareQ}`,
      timestamp: Date.now(),
      type: "compare",
    });
    const query = compareQ;
    setCompareQ("");
    setAutoFollow(true);
    setCompareLoading(true);
    try {
      const r = await api.compare({ query, document_ids: compareIds });
      addMessage({
        id: assistantId(),
        role: "assistant",
        content: r.answer,
        sources: Object.values(r.sources ?? {}).flat(),
        timestamp: Date.now(),
        type: "compare",
        meta: r,
      });
    } catch (e) {
      addMessage({
        id: assistantId(),
        role: "assistant",
        content: "Error: " + toUserMessage(e),
        timestamp: Date.now(),
        type: "compare",
      });
    } finally {
      setCompareLoading(false);
    }
  };

  // Summarize ---------------------------------------------------------------
  const [summarizeDoc, setSummarizeDoc] = useState<string | null>(null);
  const [summarizeLoading, setSummarizeLoading] = useState(false);
  const [summarizeStatus, setSummarizeStatus] = useState<TimedStatus | null>(null);
  const [armedExport, setArmedExport] = useState<"pdf" | "html" | "docx" | null>("pdf");
  const [lastSummaryDoc, setLastSummaryDoc] = useState<string | null>(null);
  const [exportingFmt, setExportingFmt] = useState<"pdf" | "html" | "docx" | null>(null);
  const [exportNote, setExportNote] = useState<{ ok: boolean; msg: string } | null>(null);

  const flashExportNote = (ok: boolean, msg: string) => {
    setExportNote({ ok, msg });
    window.setTimeout(() => setExportNote((cur) => (cur?.msg === msg ? null : cur)), 10_000);
  };

  const doManualExport = async (fmt: "pdf" | "html" | "docx") => {
    if (!summarizeDoc || summarizeLoading || exportingFmt) return;
    setExportingFmt(fmt);
    setExportNote(null);
    try {
      if (fmt === "pdf") {
        // PDF exports via a print view (same summary, no second model run).
        await api.summarizeExport(summarizeDoc, fmt);
        flashExportNote(true, "Opened print view - choose Save as PDF ✓");
        return;
      }
      const blob = await api.summarizeExport(summarizeDoc, fmt);
      const filename = `${docs.find((d) => d.id === summarizeDoc)?.original_filename || "summary"}_summary.${fmt}`;
      downloadBlob(blob, filename);
      const kb = Math.max(1, Math.round(blob.size / 1024));
      flashExportNote(true, `Exported ${filename} (${kb} KB) ✓`);
    } catch (e) {
      flashExportNote(false, `Export failed: ${toUserMessage(e)}`);
    } finally {
      setExportingFmt(null);
    }
  };

  // Export buttons double as arm-toggles: pressing one arms that format
  // (button lights up) so the export fires when summarization finishes.
  // If the selected doc was already summarized, it exports immediately.
  const onExportPress = (fmt: "pdf" | "html" | "docx") => {
    if (summarizeLoading || exportingFmt) return;
    if (lastSummaryDoc === summarizeDoc && summarizeDoc) {
      void doManualExport(fmt);
      return;
    }
    setArmedExport((cur) => (cur === fmt ? null : fmt));
  };

  const doSummarize = async () => {
    if (!summarizeDoc || summarizeLoading) return;
    const docId = summarizeDoc; // capture now; state may change mid-summary
    const doc = docs.find((d) => d.id === docId);
    const armed = armedExport;
    addMessage({
      id: Date.now().toString(),
      role: "user",
      content: `Summarize: ${doc?.original_filename || docId}`,
      timestamp: Date.now(),
      type: "summarize",
    });
    setAutoFollow(true);
    setSummarizeLoading(true);
    setExportNote(null);
    const pipelineStart = Date.now();
    setSummarizeStatus({ stage: "starting", since: pipelineStart });

    // Shared finish path for stream-done and plain-fallback responses.
    const finishSummary = (r: { summary: string; stats?: SummaryStats }) => {
      const models = r.stats?.map_model
        ? ` • map ${r.stats.map_model} → reduce ${r.stats.reduce_model} → synthesis ${r.stats.synthesis_model ?? ""}`
        : "";
      const dtype = r.stats?.doc_type ? ` • ${r.stats.doc_type}` : "";
      const text =
        r.summary +
        (r.stats
          ? `\n\n- _${r.stats.method} • ${r.stats.page_count} pages • ${r.stats.chunk_count} chunks${dtype}${models}_`
          : "");
      addMessage({ id: assistantId(), role: "assistant", content: text, timestamp: Date.now(), type: "summarize", meta: r.stats });
      setLastSummaryDoc(docId); // use captured id, not live state
      // Armed export fires the same export the manual button would, from this
      // same summary (no second model run).
      if (armed) void doManualExport(armed);
    };
    const failSummary = (msg: string) => {
      addMessage({ id: assistantId(), role: "assistant", content: "Error: " + msg, timestamp: Date.now(), type: "summarize" });
    };
    // Preserve the original pipeline start timestamp so the elapsed counter
    // runs from the very beginning of the run.
    const onStatus = (stage: string, detail?: string, current?: number, total?: number) =>
      setSummarizeStatus({ stage, detail, current, total, since: pipelineStart });

    try {
      try {
        await api.summarizeStream(
          { document_id: summarizeDoc },
          {
            onStatus,
            onDone: (data) => {
              setSummarizeStatus(null);
              finishSummary(data);
            },
            onError: (err) => {
              setSummarizeStatus(null);
              failSummary(err);
            },
          },
        );
      } catch {
        // Stream path failed - re-run with the same progress handlers so the
        // user still sees the map/reduce stages even in fallback mode.
        const r = await api.summarize({ document_id: summarizeDoc, onStatus });
        setSummarizeStatus(null);
        finishSummary(r);
      }
    } catch (e) {
      setSummarizeStatus(null);
      failSummary(toUserMessage(e));
    } finally {
      setSummarizeLoading(false);
    }
  };

  // Literature matrix -------------------------------------------------------
  const [matrixIds, setMatrixIds] = useState<string[]>([]);
  const [matrixRows, setMatrixRows] = useState<MatrixRow[] | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);

  const doMatrix = async () => {
    if (matrixIds.length < 1 || matrixLoading) return;
    setMatrixLoading(true);
    setMatrixRows(null);
    try {
      const r = await api.matrix(matrixIds);
      setMatrixRows(r.rows);
    } catch {
      setMatrixRows([]);
    } finally {
      setMatrixLoading(false);
    }
  };

  const doMatrixExport = async (format: "csv" | "xlsx" | "md") => {
    if (!matrixRows?.length) return;
    try {
      const result = await api.matrixExport(
        matrixRows.map((row) => ({ ...row })),
        format,
      );
      if (format === "md") {
        if (typeof result === "object" && "markdown" in result) {
          await navigator.clipboard.writeText(result.markdown);
        }
        return;
      }
      if (format === "xlsx") {
        if (result instanceof Blob) downloadBlob(result, "literature_matrix.xlsx");
        return;
      }
      if (typeof result === "string") {
        downloadText(result, `literature_matrix.${format}`, "text/csv");
      }
    } catch {
      /* export failures are non-fatal; the matrix stays on screen */
    }
  };

  // Cross-paper synthesis ---------------------------------------------------
  const [synthIds, setSynthIds] = useState<string[]>([]);
  const [synthQ, setSynthQ] = useState("");
  const [synthAns, setSynthAns] = useState<string | null>(null);
  const [synthLoading, setSynthLoading] = useState(false);
  const [synthStatus, setSynthStatus] = useState<PipelineStatus | null>(null);

  const doSynthesis = async () => {
    if (synthIds.length < 2 || !synthQ.trim() || synthLoading) return;
    setSynthLoading(true);
    setSynthAns(null);
    setSynthStatus({ stage: "starting" });
    try {
      const r = await api.synthesis(synthIds, synthQ, {
        onStatus: (stage, detail, current, total) => setSynthStatus({ stage, detail, current, total }),
      });
      setSynthStatus(null);
      setSynthAns(r.answer);
    } catch (e) {
      setSynthStatus(null);
      setSynthAns("Error: " + toUserMessage(e));
    } finally {
      setSynthLoading(false);
    }
  };

  const doSynthesisDocx = async () => {
    if (!synthAns) return;
    const { buildResearchDocx } = await import("@/lib/export/docx");
    const blob = await buildResearchDocx(
      "Cross-Paper Synthesis",
      synthAns,
      synthQ.trim() ? `Question: ${synthQ.trim()}` : undefined,
    );
    downloadBlob(blob, "cross_paper_synthesis.docx");
  };

  return {
    compare: {
      q: compareQ,
      setQ: setCompareQ,
      ids: compareIds,
      toggle: (id: string) => setCompareIds((ids) => toggleId(ids, id)),
      loading: compareLoading,
      run: doCompare,
    },
    summarize: {
      docId: summarizeDoc,
      setDocId: setSummarizeDoc,
      loading: summarizeLoading,
      status: summarizeStatus,
      armed: armedExport,
      exportingFmt,
      note: exportNote,
      run: doSummarize,
      pressExport: onExportPress,
    },
    matrix: {
      ids: matrixIds,
      toggle: (id: string) => setMatrixIds((ids) => toggleId(ids, id)),
      rows: matrixRows,
      loading: matrixLoading,
      run: doMatrix,
      exportRows: doMatrixExport,
    },
    synthesis: {
      ids: synthIds,
      toggle: (id: string) => setSynthIds((ids) => toggleId(ids, id)),
      q: synthQ,
      setQ: setSynthQ,
      answer: synthAns,
      loading: synthLoading,
      status: synthStatus,
      run: doSynthesis,
      exportDocx: doSynthesisDocx,
    },
  };
}
