"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DuplicatePair } from "@/lib/wb/quickAddAndMerge";

interface DuplicateMergerModalProps {
  open: boolean;
  onClose: () => void;
  onMerged: () => void;
}

export default function DuplicateMergerModal({ open, onClose, onMerged }: DuplicateMergerModalProps) {
  const [loading, setLoading] = useState(false);
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [keepRightMap, setKeepRightMap] = useState<Record<string, boolean>>({});
  const [fieldChoices, setFieldChoices] = useState<Record<string, { title?: "left" | "right"; doi?: "left" | "right"; year?: "left" | "right"; journal?: "left" | "right" }>>({});

  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.resolve()
      .then(() => {
        if (!active) return;
        setLoading(true);
        setError(null);
        return api.findDuplicates();
      })
      .then((res) => {
        if (active && res) setPairs(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to scan duplicates");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

  const pick = (pair: DuplicatePair, field: "title" | "doi" | "year" | "journal", keepRight: boolean) => {
    const choice = fieldChoices[pair.key]?.[field] ?? (keepRight ? "right" : "left");
    const chosenDoc = choice === "right" ? pair.right : pair.left;
    return chosenDoc[field];
  };

  const handleMerge = async (pair: DuplicatePair) => {
    setMergingKey(pair.key);
    setError(null);
    try {
      const keepRight = Boolean(keepRightMap[pair.key]);
      const primary = keepRight ? pair.right : pair.left;
      const secondary = keepRight ? pair.left : pair.right;
      const mergedAuthors = Array.from(new Set([...primary.authors, ...secondary.authors].filter(Boolean)));
      await api.mergeDuplicates(primary.id, secondary.id, {
        title: pick(pair, "title", keepRight) || primary.title,
        doi: pick(pair, "doi", keepRight) ?? primary.doi ?? secondary.doi,
        year: pick(pair, "year", keepRight) ?? primary.year ?? secondary.year,
        journal: pick(pair, "journal", keepRight) ?? primary.journal ?? secondary.journal,
        abstract: primary.abstract || secondary.abstract,
        volume: primary.volume || secondary.volume,
        issue: primary.issue || secondary.issue,
        pages: primary.pages || secondary.pages,
        publisher: primary.publisher || secondary.publisher,
        authors: mergedAuthors,
      });
      setPairs((prev) => prev.filter((p) => p.key !== pair.key && p.left.id !== secondary.id && p.right.id !== secondary.id));
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMergingKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#2f2f2f] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Library Duplicate Merger</h2>
            <p className="text-xs text-[#8e8e8e]">
              Compare matching DOI or high-similarity titles side by side. Merging preserves annotations, collections, tags, project links, and attached PDFs.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-[#2f2f2f] px-3 py-1.5 text-xs text-[#d4d4d4] hover:text-white">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {loading && <div className="text-sm text-[#8e8e8e]">Scanning workspace records for duplicates…</div>}
          {error && <div className="rounded-xl border border-[#7f1d1d] bg-[#261212] p-3 text-xs text-[#fca5a5]">{error}</div>}
          {!loading && pairs.length === 0 && (
            <div className="rounded-xl border border-[#2f2f2f] bg-[#141414] p-6 text-sm text-[#8e8e8e]">
              No duplicate DOI or high-similarity title pairs detected in the workspace.
            </div>
          )}

          {pairs.map((pair) => {
            const keepRight = Boolean(keepRightMap[pair.key]);
            return (
              <div key={pair.key} className="rounded-2xl border border-[#2f2f2f] bg-[#141414] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="rounded-full border border-[#3f3f46] bg-black px-2.5 py-0.5 text-white">
                    Match: {pair.reason} ({Math.round(pair.score * 100)}%)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setKeepRightMap((m) => ({ ...m, [pair.key]: !keepRight }))}
                      className="rounded-lg border border-[#2f2f2f] bg-black px-2.5 py-1 text-[#d4d4d4] hover:text-white"
                    >
                      Keep {keepRight ? "Right (Record B)" : "Left (Record A)"} as Primary - Swap
                    </button>
                    <button
                      type="button"
                      disabled={mergingKey === pair.key}
                      onClick={() => void handleMerge(pair)}
                      className="rounded-lg bg-white px-3 py-1 font-medium text-black disabled:opacity-40 hover:bg-[#e5e5e5]"
                    >
                      {mergingKey === pair.key ? "Merging…" : "Merge pair"}
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 text-xs">
                  {(["left", "right"] as const).map((side) => {
                    const doc = side === "left" ? pair.left : pair.right;
                    const isPrimary = (side === "right") === keepRight;
                    return (
                      <div
                        key={side}
                        className={`rounded-xl border p-3 space-y-1.5 ${
                          isPrimary ? "border-white/50 bg-black" : "border-[#2f2f2f] bg-[#0a0a0a]"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-[#8e8e8e]">
                          <span>{side === "left" ? "Record A" : "Record B"} {isPrimary ? "• PRIMARY (kept)" : "• SECONDARY (merged & deleted)"}</span>
                          <span>{doc.storage_path ? "Has PDF" : "Metadata only"}</span>
                        </div>
                        <div className="text-sm font-medium text-white">{doc.title}</div>
                        <div className="text-[#b4b4b4]">Authors: {doc.authors.join(", ") || "-"}</div>
                        <div className="text-[#8e8e8e]">Year: {doc.year ?? "-"} • DOI: {doc.doi ?? "-"}</div>
                        <div className="text-[#8e8e8e]">Venue: {doc.journal ?? "-"}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap gap-3 border-t border-[#2f2f2f] pt-2 text-[11px] text-[#b4b4b4]">
                  {(["title", "doi", "year", "journal"] as const).map((field) => (
                    <label key={field} className="flex items-center gap-1">
                      <span className="capitalize">{field}:</span>
                      <select
                        value={fieldChoices[pair.key]?.[field] ?? (keepRight ? "right" : "left")}
                        onChange={(e) =>
                          setFieldChoices((prev) => ({
                            ...prev,
                            [pair.key]: { ...prev[pair.key], [field]: e.target.value as "left" | "right" },
                          }))
                        }
                        className="rounded border border-[#2f2f2f] bg-black px-1.5 py-0.5 text-white"
                      >
                        <option value="left">Use A</option>
                        <option value="right">Use B</option>
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
