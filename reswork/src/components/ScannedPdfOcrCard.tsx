"use client";
import { useState } from "react";
import { useInference } from "@/contexts/InferenceContext";
import { extractScannedPdfOcr, MAX_OCR_PAGES } from "@/lib/ingestion/ocr";

interface ScannedPdfOcrCardProps {
  file: File;
  onTextRecovered: (text: string) => void;
}

export default function ScannedPdfOcrCard({ file, onTextRecovered }: ScannedPdfOcrCardProps) {
  const { settings } = useInference();
  const initialMode = settings.provider === "cloud" ? "cloud" : "local";
  const [ocrMode, setOcrMode] = useState<"local" | "cloud">(initialMode);
  const [modelName, setModelName] = useState(
    initialMode === "cloud" ? settings.cloudModel || "gpt-4o-mini" : settings.model || "qwen2.5vl:7b"
  );
  const [cloudProvider, setCloudProvider] = useState<string>(settings.cloudProvider || "openai");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  const runVisionOcr = async () => {
    if (!isPdf || busy) return;
    setBusy(true);
    setError(null);
    setProgress("Preparing scanned pages…");
    try {
      const res = await extractScannedPdfOcr(file, {
        mode: ocrMode,
        model: modelName,
        cloudProvider: ocrMode === "cloud" ? cloudProvider : undefined,
        maxPages: MAX_OCR_PAGES,
        onProgress: (p, total) => setProgress(`OCR page ${p} / ${total}…`),
      });
      if (!res.text.trim()) {
        setError("Vision OCR completed but returned no readable text. Paste OCR text below if available.");
        return;
      }
      onTextRecovered(res.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vision OCR failed");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const applyManualText = () => {
    const clean = manualText.trim();
    if (!clean) return;
    onTextRecovered(clean);
  };

  return (
    <div className="mx-5 mt-4 rounded-xl bg-amber-950/30 border border-amber-800 p-4 text-sm text-amber-200 space-y-3">
      <div>
        <div className="font-semibold text-amber-300">No selectable text detected (scanned / image-only file)</div>
        <div className="mt-1 text-xs text-amber-200/80">
          Accepting now would store this item as metadata-only. Recover searchable text using a vision model (up to {MAX_OCR_PAGES} pages) or paste OCR text below.
        </div>
      </div>

      {isPdf && (
        <div className="rounded-xl border border-[#2f2f2f] bg-black/60 p-3 space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-3 text-xs">
            <select
              aria-label="OCR provider mode"
              value={ocrMode}
              onChange={(e) => {
                const next = e.target.value as "local" | "cloud";
                setOcrMode(next);
                setModelName(next === "cloud" ? settings.cloudModel || "gpt-4o-mini" : settings.model || "qwen2.5vl:7b");
              }}
              className="rounded-lg border border-[#2f2f2f] bg-[#171717] px-2.5 py-1.5 text-white"
            >
              <option value="local">Local Ollama Vision</option>
              <option value="cloud">Cloud Vision (BYOK proxy)</option>
            </select>

            {ocrMode === "cloud" && (
              <select
                aria-label="Cloud vision provider"
                value={cloudProvider}
                onChange={(e) => setCloudProvider(e.target.value)}
                className="rounded-lg border border-[#2f2f2f] bg-[#171717] px-2.5 py-1.5 text-white"
              >
                <option value="openai">OpenAI</option>
                <option value="google">Google Gemini</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            )}

            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="Vision model name"
              className="rounded-lg border border-[#2f2f2f] bg-[#171717] px-2.5 py-1.5 text-white placeholder:text-[#5f5f5f]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !modelName.trim()}
              onClick={() => void runVisionOcr()}
              className="rounded-lg bg-white text-black px-3.5 py-1.5 text-xs font-medium disabled:opacity-40 hover:bg-[#e5e5e5]"
            >
              {busy ? progress || "Running Vision OCR…" : `Run Vision OCR (first ${MAX_OCR_PAGES} pages)`}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-xs text-amber-200/80">Or paste externally OCR&apos;d text manually:</div>
        <textarea
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          rows={3}
          placeholder="Paste plain text here (supports [Page N] markers)…"
          className="w-full rounded-lg border border-[#2f2f2f] bg-black px-3 py-2 text-xs text-white placeholder:text-[#5f5f5f]"
        />
        <button
          type="button"
          disabled={!manualText.trim()}
          onClick={applyManualText}
          className="rounded-lg border border-[#3f3f46] bg-[#171717] px-3 py-1.5 text-xs text-white disabled:opacity-40 hover:bg-[#27272a]"
        >
          Apply recovered text
        </button>
      </div>
    </div>
  );
}
