"use client";

import { useInference, type InferenceSettings } from "@/contexts/InferenceContext";
import { Panel, fieldClass } from "@/components/ui/Panel";
import { StageModelEditor } from "@/components/settings/StageModelEditor";

/** Makalah stage routing, thinking, and output budget. */
export function MakalahPipelineCard() {
  const { settings: inf, setSettings: setInf } = useInference();
  const thinkLevel = inf.makalahThinkLevel ?? "low";

  return (
    <Panel
      title="Makalah pipeline"
      description="Outline is cheap structure-only work (a small/fast model is fine). Section drafting writes the actual prose with citations — use your strongest model here. Both inherit the chat model above unless overridden. Changes apply on the next run."
    >
      <div className="mt-4 grid grid-cols-1 gap-3 border-t border-[#2f2f2f] pt-3 md:grid-cols-2">
        <div className="text-xs text-[#8e8e8e]">
          Thinking — section drafting only
          <div className="mt-1">
            <button
              onClick={() => setInf({ makalahThinking: !inf.makalahThinking })}
              className={`rounded-full border px-4 py-1.5 text-xs font-medium transition ${
                inf.makalahThinking
                  ? "border-emerald-600 bg-emerald-500/15 text-emerald-300"
                  : "border-[#2f2f2f] bg-[#212121] text-[#8e8e8e] hover:text-white"
              }`}
              title="Off (default): deterministic JSON. On: model reasons step-by-step first — costs output tokens."
            >
              {inf.makalahThinking ? "● On" : "○ Off"}
            </button>
          </div>
          <div className="mt-1 text-[11px] text-[#5f5f5f]">
            Outline + claim check never think — reasoning runs only while drafting sections. Note: native reasoning models can
            still think on their own — if calls fail with “only reasoning”, use a non-reasoning model for that stage.
          </div>
        </div>
        {inf.makalahThinking ? (
          <>
            <label className="text-xs text-[#8e8e8e]">
              Thinking level (server trace bound)
              <select
                value={thinkLevel}
                onChange={(e) => setInf({ makalahThinkLevel: e.target.value as InferenceSettings["makalahThinkLevel"] })}
                className={fieldClass}
              >
                <option value="minimal">Minimal — closest to off (Gemini 3)</option>
                <option value="low">Low — brief trace</option>
                <option value="medium">Medium</option>
                <option value="high">High — deep trace</option>
                <option value="max">Max</option>
              </select>
              <span className="text-[11px] text-[#5f5f5f]">
                Bounds the trace server-side (qwen3/deepseek families, Gemini thinking_level). Ollama has no hard numeric cap,
                so this pairs with the token budget below.
              </span>
            </label>
            <label className="text-xs text-[#8e8e8e]">
              Thinking budget (tokens)
              <input
                type="number"
                min={128}
                max={4096}
                step={64}
                value={inf.makalahThinkingBudget ?? 1024}
                onChange={(e) => setInf({ makalahThinkingBudget: Number(e.target.value) || 1024 })}
                className={fieldClass}
              />
              <span className="text-[11px] text-[#5f5f5f]">
                Hard cap: deliberation runs with exactly this many tokens, then the answer is written cold with the full output
                cap — thinking can never truncate the answer. The model is also told its allowance.
              </span>
            </label>
          </>
        ) : null}
        <label className="text-xs text-[#8e8e8e]">
          Max output tokens / call (num_predict)
          <input
            type="number"
            min={256}
            max={16384}
            step={256}
            value={inf.makalahNumPredict ?? 3072}
            onChange={(e) => setInf({ makalahNumPredict: Number(e.target.value) || 3072 })}
            className={fieldClass}
          />
          <span className="text-[11px] text-[#5f5f5f]">
            Caps outline + section answers (Ollama num_predict, cloud max_tokens). Raise if long sections truncate; lower to save
            VRAM/time.
          </span>
        </label>
      </div>
      <StageModelEditor
        stageKey="makalahOutlineStage"
        label="Outline — structure proposal (LLM call #1)"
        description="Structure only; a small/fast model is usually enough."
      />
      <StageModelEditor
        stageKey="makalahSectionStage"
        label="Sections — drafting + claim check (LLM call #2)"
        description="Writes cited prose. Use the strongest model you can afford."
      />
    </Panel>
  );
}
