"use client";

import { useInference, type InferenceSettings, type StageModel } from "@/contexts/InferenceContext";
import { fieldClass } from "@/components/ui/Panel";

export type StageKey =
  | "mapStage"
  | "reduceStage"
  | "synthesisStage"
  | "makalahOutlineStage"
  | "makalahSectionStage";

/**
 * One stage override editor shared by the summarization and Makalah cards.
 * Inherit is the default; choosing Ollama/Cloud only edits that stage, never
 * the global chat provider.
 */
export function StageModelEditor({
  stageKey,
  label,
  description,
}: {
  stageKey: StageKey;
  label: string;
  description?: string;
}) {
  const { settings: inf, setSettings: setInf } = useInference();
  const stage: StageModel = inf[stageKey];
  const set = (patch: Partial<StageModel>) => {
    setInf({ [stageKey]: { ...stage, ...patch } } as Pick<InferenceSettings, StageKey>);
  };

  const effective =
    stage.provider === "inherit"
      ? "using chat model"
      : stage.provider === "ollama"
        ? `ollama:${stage.model || inf.model}`
        : `${stage.cloudProvider}:${stage.cloudModel || inf.cloudModel}`;

  return (
    <div className="mt-4 border-t border-[#2f2f2f] pt-3">
      <div className="text-xs font-medium text-[#ececec]">
        {label}
        <span className="ml-2 text-[11px] font-normal text-[#5f5f5f]">{effective}</span>
      </div>
      {description ? <p className="mt-1 text-[11px] text-[#5f5f5f]">{description}</p> : null}
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="text-xs text-[#8e8e8e]">
          Provider
          <select
            value={stage.provider}
            onChange={(e) => set({ provider: e.target.value as StageModel["provider"] })}
            className={fieldClass}
          >
            <option value="inherit">Inherit chat model</option>
            <option value="ollama">Ollama</option>
            <option value="cloud">Cloud</option>
          </select>
        </label>
        {stage.provider === "ollama" ? (
          <label className="text-xs text-[#8e8e8e]">
            Ollama model
            <input
              value={stage.model}
              onChange={(e) => set({ model: e.target.value })}
              list="ollama-models"
              placeholder={inf.model}
              className={fieldClass}
            />
          </label>
        ) : null}
        {stage.provider === "cloud" ? (
          <>
            <label className="text-xs text-[#8e8e8e]">
              Cloud provider
              <select
                value={stage.cloudProvider}
                onChange={(e) => set({ cloudProvider: e.target.value as StageModel["cloudProvider"] })}
                className={fieldClass}
              >
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="google">Google</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label className="text-xs text-[#8e8e8e]">
              Cloud model
              <input
                value={stage.cloudModel}
                onChange={(e) => set({ cloudModel: e.target.value })}
                list="cloud-models"
                placeholder={inf.cloudModel}
                className={fieldClass}
              />
            </label>
          </>
        ) : null}
      </div>
    </div>
  );
}
