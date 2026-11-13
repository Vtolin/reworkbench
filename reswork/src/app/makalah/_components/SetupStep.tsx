"use client";

import { useInference } from "@/contexts/InferenceContext";
import { makalahStageLabels } from "@/lib/wb/makalah";
import { useMakalahWorkbench } from "./MakalahWorkbenchContext";
import { toggleId } from "./types";

/** STEP 1 - topic, grounding, sources, template constraints and cover. */
export function SetupStep() {
  const { draft } = useMakalahWorkbench();
  const {
    docs,
    topic,
    setTopic,
    language,
    setLanguage,
    academicLevel,
    setAcademicLevel,
    citationStyle,
    setCitationStyle,
    targetWords,
    setTargetWords,
    mode,
    setMode,
    selected,
    setSelected,
    hybridMode,
    setHybridMode,
    chaptersText,
    setChaptersText,
    minSubs,
    setMinSubs,
    maxSubs,
    setMaxSubs,
    cover,
    setCover,
    outline,
    setStep,
    runOutline,
    startModeB,
  } = draft;
  const { settings } = useInference();
  const { outline: outlineModelLabel, section: sectionModelLabel } = makalahStageLabels(settings);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
        <label className="block text-xs text-[#8e8e8e]">Topik / Topic</label>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="cth. Kecerdasan Buatan dalam Penelitian Hukum"
          className="w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2.5 text-sm text-white outline-none"
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block text-xs text-[#8e8e8e]">
            Language
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            >
              <option value="id-ID">id-ID (Indonesia)</option>
              <option value="en-US">en-US (English)</option>
            </select>
          </label>
          <label className="block text-xs text-[#8e8e8e]">
            Academic level
            <select
              value={academicLevel}
              onChange={(e) => setAcademicLevel(e.target.value)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            >
              <option value="undergraduate">undergraduate</option>
              <option value="graduate">graduate</option>
              <option value="high_school">high_school</option>
              <option value="general">general</option>
            </select>
          </label>
          <label className="block text-xs text-[#8e8e8e]">
            Citation style
            <input
              value={citationStyle}
              onChange={(e) => setCitationStyle(e.target.value)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs text-[#8e8e8e]">
            Target words / subsection
            <input
              type="number"
              min={100}
              max={1000}
              value={targetWords}
              onChange={(e) => setTargetWords(Number(e.target.value) || 300)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              onClick={() => setMode("A")}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs ${
                mode === "A"
                  ? "bg-white text-black border-white font-medium"
                  : "border-[#2f2f2f] bg-[#212121] text-white"
              }`}
            >
              Mode A - AI proposes outline
            </button>
            <button
              onClick={() => setMode("B")}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs ${
                mode === "B"
                  ? "bg-white text-black border-white font-medium"
                  : "border-[#2f2f2f] bg-[#212121] text-white"
              }`}
            >
              Mode B - I define structure
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-white">Grounding</span>
          {(["off", "15/85", "30/70"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setHybridMode(m)}
              title={
                m === "off"
                  ? "100% strict - setiap klaim faktual wajib dari passages"
                  : m === "15/85"
                    ? "85% sumber + 15% kecerdasan model untuk transisi/koherensi (disarankan)"
                    : "70% sumber + 30% kecerdasan model untuk sintesis/kerangka teori"
              }
              className={`rounded-full px-3 py-1.5 text-xs border ${
                hybridMode === m
                  ? "bg-white text-black border-white font-medium"
                  : "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e] hover:text-white"
              }`}
            >
              {m === "off" ? "Strict" : m}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-[#5f5f5f]">
          Strict = 100% sitasi sumber. 15/85 = +transisi narasi (disarankan). 30/70 = +sintesis
          teori. Paragraf tanpa sitasi selalu ditandai sebagai model-bridged di quality report -
          tidak pernah diklaim bersumber.
        </div>
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-2">
        <div className="flex items-center">
          <span className="text-sm font-medium text-white">
            Sources ({selected.length}/{docs.length})
          </span>
          <button
            onClick={() =>
              setSelected(selected.length === docs.length ? [] : docs.map((d) => d.id))
            }
            className="ml-auto text-xs text-[#8e8e8e] hover:text-white"
          >
            {selected.length === docs.length ? "Clear" : "Select all"}
          </button>
        </div>
        <div className="max-h-48 overflow-y-auto space-y-1.5">
          {docs.map((d) => {
            const on = selected.includes(d.id);
            return (
              <button
                key={d.id}
                onClick={() => setSelected(toggleId(selected, d.id))}
                className={`w-full text-left rounded-xl border px-3 py-2 text-xs ${
                  on
                    ? "bg-white text-black border-white"
                    : "bg-[#171717] border-[#2f2f2f] text-[#ececec]"
                }`}
              >
                {on ? "✓ " : ""}
                {d.original_filename}{" "}
                {d.title && d.title !== d.original_filename ? `- ${d.title.slice(0, 60)}` : ""}
              </button>
            );
          })}
          {!docs.length && (
            <div className="text-xs text-[#5f5f5f]">
              No documents - upload and approve in Library first.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
        <span className="text-sm font-medium text-white">Template constraints</span>
        <label className="block text-xs text-[#8e8e8e]">
          Required chapters (one per line)
          <textarea
            value={chaptersText}
            onChange={(e) => setChaptersText(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-[#8e8e8e]">
            Min subsections / chapter
            <input
              type="number"
              min={1}
              max={10}
              value={minSubs}
              onChange={(e) => setMinSubs(Number(e.target.value) || 2)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
          </label>
          <label className="block text-xs text-[#8e8e8e]">
            Max subsections / chapter
            <input
              type="number"
              min={1}
              max={10}
              value={maxSubs}
              onChange={(e) => setMaxSubs(Number(e.target.value) || 5)}
              className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
            />
          </label>
        </div>
      </div>

      <div className="rounded-2xl bg-[#0a0a0a] border border-[#2f2f2f] p-4 space-y-3">
        <span className="text-sm font-medium text-white">Cover (optional, used in PDF)</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(["title", "author", "nim", "course", "lecturer"] as const).map((f) => (
            <label
              key={f}
              className={`block text-xs text-[#8e8e8e] ${f === "title" ? "sm:col-span-2" : ""}`}
            >
              {f}
              <input
                value={cover[f]}
                onChange={(e) => setCover({ ...cover, [f]: e.target.value })}
                placeholder={f === "title" ? topic || "Judul makalah" : ""}
                className="mt-1 w-full rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-end flex-wrap gap-2 items-center">
        <span className="text-[11px] text-[#5f5f5f] mr-auto">
          outline {outlineModelLabel} • sections {sectionModelLabel}
          {settings.makalahThinking
            ? ` • thinking ${settings.makalahThinkLevel ?? "low"} · ${settings.makalahThinkingBudget ?? 1024} tok (drafting only)`
            : " • thinking off"}{" "}
          - change in Settings → Makalah pipeline
        </span>
        {mode === "A" ? (
          <button
            onClick={() => {
              setStep(2);
              if (!outline.length) void runOutline();
            }}
            disabled={!topic.trim() || !selected.length}
            className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Continue → outline
          </button>
        ) : (
          <button
            onClick={startModeB}
            disabled={!topic.trim()}
            className="rounded-xl bg-white text-black px-6 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Continue → define structure
          </button>
        )}
      </div>
    </div>
  );
}
