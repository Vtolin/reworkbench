"use client";

import { useInference } from "@/contexts/InferenceContext";
import { Panel, fieldClass } from "@/components/ui/Panel";
import { StageModelEditor } from "@/components/settings/StageModelEditor";

const STAGES = [
  { key: "mapStage", label: "Map — per-chunk extraction" },
  { key: "reduceStage", label: "Reduce — combining + final summary" },
  { key: "synthesisStage", label: "Synthesis — cross-paper" },
] as const;

/** Summarization method + per-stage model overrides. */
export function SummarizationCard() {
  const { settings: inf, setSettings: setInf } = useInference();

  return (
    <Panel
      title="Summarization pipeline"
      description={
        <>
          <span className="text-white">Single pass</span> stitches the doc into one prompt with the chat model.
          <span className="text-white"> Map→reduce</span> extracts each chunk with the map model, then combines with the reduce
          model — slower but handles long docs. Cross-paper synthesis uses the synthesis model. Progress shows per chunk (
          <span className="font-mono">Extracting 1/20 chunks</span>).
        </>
      }
    >
      <label className="mt-4 block text-xs font-medium text-[#ececec]">
        Method
        <select
          value={inf.summarizeMethod ?? "stuff"}
          onChange={(e) => setInf({ summarizeMethod: e.target.value as "stuff" | "map_reduce" })}
          className={fieldClass}
        >
          <option value="stuff">Single pass (chat model)</option>
          <option value="map_reduce">Map → reduce (per-chunk)</option>
        </select>
      </label>
      {STAGES.map((stage) => (
        <StageModelEditor key={stage.key} stageKey={stage.key} label={stage.label} />
      ))}
    </Panel>
  );
}
