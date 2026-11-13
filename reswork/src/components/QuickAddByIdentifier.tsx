"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { fetchMetadata, type MetadataCandidate } from "@/lib/wb/openalex";
import { parseIdentifierInput } from "@/lib/wb/quickAddAndMerge";

export default function QuickAddByIdentifier({ onAdded }: { onAdded?: () => void }) {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("doi") || searchParams.get("title") || "";
  const clippedUrl = searchParams.get("url") || "";

  const [query, setQuery] = useState(initialQuery);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MetadataCandidate[]>([]);

  const [title, setTitle] = useState(searchParams.get("title") || "");
  const [authorsText, setAuthorsText] = useState("");
  const [year, setYear] = useState("");
  const [doi, setDoi] = useState(searchParams.get("doi") || "");
  const [journal, setJournal] = useState("");
  const [volume, setVolume] = useState("");
  const [issue, setIssue] = useState("");
  const [pages, setPages] = useState("");
  const [publisher, setPublisher] = useState("");
  const [abstract, setAbstract] = useState("");
  const [docType, setDocType] = useState("journal");
  const [sourceUrl, setSourceUrl] = useState(clippedUrl);
  const [metaSource, setMetaSource] = useState<string | null>(null);
  const [metaConf, setMetaConf] = useState<number | null>(null);

  const applyCandidate = (c: MetadataCandidate) => {
    setTitle(c.title ?? "");
    setAuthorsText(c.authors.join("; "));
    setYear(c.year ? String(c.year) : "");
    setDoi(c.doi ?? "");
    setJournal(c.journal ?? "");
    setVolume(c.volume ?? "");
    setIssue(c.issue ?? "");
    setPages(c.pages ?? "");
    setPublisher(c.publisher ?? "");
    setAbstract(c.abstract ?? "");
    setDocType(c.document_type ?? "journal");
    setMetaSource(c.source);
    setMetaConf(c.confidence);
  };

  const runLookup = async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    setLookingUp(true);
    setError(null);
    setStatus(null);
    try {
      const parsed = parseIdentifierInput(trimmed);
      const res = await fetchMetadata(parsed);
      setCandidates(res.candidates);
      if (res.proposal && (res.proposal.title || res.candidates.length === 0)) {
        applyCandidate(res.proposal);
      } else if (res.candidates.length > 0) {
        applyCandidate(res.candidates[0]);
      }
      if (res.error && !res.proposal.title) {
        setError(res.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Identifier lookup failed");
    } finally {
      setLookingUp(false);
    }
  };

  useEffect(() => {
    const qDoi = searchParams.get("doi");
    if (!qDoi) return;
    let active = true;
    const parsed = parseIdentifierInput(qDoi);
    fetchMetadata(parsed)
      .then((res) => {
        if (!active) return;
        setCandidates(res.candidates);
        if (res.proposal && (res.proposal.title || res.candidates.length === 0)) {
          applyCandidate(res.proposal);
        } else if (res.candidates.length > 0) {
          applyCandidate(res.candidates[0]);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // Run once on initial bookmarklet query param arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (allowDuplicate = false) => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const parsedYear = year.trim() ? Number.parseInt(year.trim(), 10) : null;
      const authors = authorsText
        .split(/[;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.quickAdd({
        title: title.trim(),
        authors,
        year: Number.isFinite(parsedYear) ? parsedYear : null,
        doi: doi.trim() || null,
        journal: journal.trim() || null,
        volume: volume.trim() || null,
        issue: issue.trim() || null,
        pages: pages.trim() || null,
        publisher: publisher.trim() || null,
        abstract: abstract.trim() || null,
        document_type: docType || null,
        source_url: sourceUrl.trim() || null,
        metadata_source: metaSource ?? "quick_add",
        metadata_confidence: metaConf,
        allowDuplicate,
      });
      setStatus(
        res.status === "approved"
          ? "Reference added to workspace library."
          : "Reference saved as pending admin approval."
      );
      setQuery("");
      setTitle("");
      setAuthorsText("");
      setYear("");
      setDoi("");
      setJournal("");
      setVolume("");
      setIssue("");
      setPages("");
      setPublisher("");
      setAbstract("");
      setCandidates([]);
      onAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save reference");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-5 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-white">Quick Add by Identifier (Metadata-only)</h2>
        <p className="mt-1 text-xs text-[#8e8e8e]">
          Paste a DOI, DOI URL, ISBN, PMID, or paper title to resolve bibliographic metadata without uploading a PDF.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runLookup(query)}
          placeholder="10.1038/..., 978-0-..., PMID:12345678, or article title"
          className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
        />
        <button
          type="button"
          disabled={lookingUp || !query.trim()}
          onClick={() => void runLookup(query)}
          className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-[#e5e5e5]"
        >
          {lookingUp ? "Looking up…" : "Lookup metadata"}
        </button>
      </div>

      {candidates.length > 1 && (
        <div className="rounded-xl border border-[#2f2f2f] bg-[#141414] p-3 space-y-1.5">
          <div className="text-xs font-medium text-[#b4b4b4]">Multiple matches found — choose one:</div>
          {candidates.slice(0, 4).map((c, idx) => (
            <button
              key={`${c.doi ?? c.title ?? idx}-${idx}`}
              type="button"
              onClick={() => applyCandidate(c)}
              className="block w-full text-left rounded-lg border border-[#2f2f2f] bg-black px-3 py-2 text-xs text-[#ececec] hover:border-[#52525b]"
            >
              <span className="font-medium text-white">{c.title ?? "(untitled)"}</span>
              <span className="text-[#8e8e8e]"> — {c.authors[0] ?? "Unknown"} ({c.year ?? "?"})</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2 text-xs text-[#8e8e8e]">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          Authors (semicolon-separated)
          <input
            value={authorsText}
            onChange={(e) => setAuthorsText(e.target.value)}
            placeholder="Ada Lovelace; Grace Hopper"
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          Year
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            placeholder="2025"
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          DOI
          <input
            value={doi}
            onChange={(e) => setDoi(e.target.value)}
            placeholder="10.xxxx/xxxxx"
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          Journal / Venue
          <input
            value={journal}
            onChange={(e) => setJournal(e.target.value)}
            placeholder="Journal or conference"
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          Publisher
          <input
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-xs text-[#8e8e8e]">
          Source URL (optional)
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://..."
            className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white"
          />
        </label>
      </div>

      {error && (
        <div className="rounded-xl border border-[#7f1d1d] bg-[#261212] p-3 text-xs text-[#fca5a5] flex items-center justify-between gap-2">
          <span>{error}</span>
          {error.includes("duplicate") && (
            <button
              type="button"
              onClick={() => void handleSave(true)}
              className="rounded-lg border border-[#7f1d1d] px-2.5 py-1 text-white hover:bg-[#7f1d1d]/30"
            >
              Add anyway
            </button>
          )}
        </div>
      )}
      {status && <div className="text-xs text-[#86efac]">{status}</div>}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving || !title.trim()}
          onClick={() => void handleSave(false)}
          className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-[#e5e5e5]"
        >
          {saving ? "Saving…" : "Save reference to library"}
        </button>
      </div>
    </div>
  );
}
