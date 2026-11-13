"use client";

import Topbar from "@/components/Topbar";
import MakalahHistoryPanel from "@/components/MakalahHistoryPanel";
import { useInference } from "@/contexts/InferenceContext";
import { DraftingStep } from "./_components/DraftingStep";
import {
  MakalahWorkbenchProvider,
  useMakalahWorkbench,
} from "./_components/MakalahWorkbenchContext";
import { OutlineStep } from "./_components/OutlineStep";
import { ResultStep } from "./_components/ResultStep";
import { SetupStep } from "./_components/SetupStep";

const STEP_LABELS = ["Setup", "Outline", "Drafting", "Result"];

export default function MakalahPage() {
  return (
    <MakalahWorkbenchProvider>
      <MakalahShell />
    </MakalahWorkbenchProvider>
  );
}

/** Route shell: history drawer, step navigation and the active step body. */
function MakalahShell() {
  const { draft } = useMakalahWorkbench();
  const { settings } = useInference();
  const {
    persistError,
    historyOpen,
    setHistoryOpen,
    openDraft,
    handleNew,
    step,
    setStep,
    outline,
    approved,
  } = draft;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black min-h-0 relative">
      <Topbar
        title="Makalah"
        subtitle="Deterministic drafting pipeline - outline, approve, draft per section, export PDF"
      />
      {historyOpen && (
        <div className="absolute inset-0 z-20 flex">
          <aside className="w-64 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] h-full flex flex-col shadow-2xl">
            <MakalahHistoryPanel
              onOpen={openDraft}
              onNew={handleNew}
              onNavigate={() => setHistoryOpen(false)}
            />
          </aside>
          <button
            className="flex-1 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setHistoryOpen(false)}
            aria-label="close history"
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
          {persistError && (
            <div className="text-xs text-amber-300 border border-amber-800 bg-amber-950/30 rounded-xl px-3 py-2">
              ⚠ {persistError}
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto no-scrollbar items-center">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className={`h-9 w-9 grid place-items-center rounded-xl border text-[#ececec] shrink-0 ${
                historyOpen
                  ? "bg-white text-black border-white"
                  : "bg-[#212121] border-[#2f2f2f] hover:bg-[#2f2f2f]"
              }`}
              title="Makalah history"
              aria-label="Makalah history"
            >
              ☰
            </button>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                onClick={() => {
                  if (n < step || (n === 2 && outline.length) || (n === 3 && approved)) setStep(n);
                }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap ${
                  step === n
                    ? "bg-white text-black border-white"
                    : "bg-[#171717] border-[#2f2f2f] text-[#8e8e8e]"
                }`}
              >
                {n}. {STEP_LABELS[n - 1]}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-[#5f5f5f] self-center shrink-0 hidden sm:block">
              {settings.provider === "ollama"
                ? `ollama:${settings.model}`
                : `${settings.cloudProvider}:${settings.cloudModel}`}
            </span>
          </div>

          {step === 1 && <SetupStep />}
          {step === 2 && <OutlineStep />}
          {step === 3 && <DraftingStep />}
          {step === 4 && <ResultStep />}
        </div>
      </div>
    </div>
  );
}
