"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { buildBookmarkletHref, type ZoteroLibraryType } from "@/lib/importing/zotero";

interface ZoteroCapturePanelProps {
  onImported?: (summary: string) => void;
}

export default function ZoteroCapturePanel({ onImported }: ZoteroCapturePanelProps) {
  const [libraryType, setLibraryType] = useState<ZoteroLibraryType>("users");
  const [libraryId, setLibraryId] = useState("");
  const [collectionKey, setCollectionKey] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedClipper, setCopiedClipper] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const bookmarkletHref = useMemo(() => buildBookmarkletHref(origin), [origin]);

  const handleSync = async () => {
    if (!libraryId.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await api.importZotero({
        libraryType,
        libraryId: libraryId.trim(),
        collectionKey: collectionKey.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      const msg = `Synced from Zotero: ${res.imported} imported, ${res.skipped} skipped as duplicates/failed.`;
      setStatus(msg);
      onImported?.(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync Zotero library");
    } finally {
      setBusy(false);
    }
  };

  const copyClipper = async () => {
    try {
      await navigator.clipboard.writeText(bookmarkletHref);
      setCopiedClipper(true);
      setTimeout(() => setCopiedClipper(false), 2000);
    } catch {
      // Fallback: user can drag the link directly to bookmarks bar
    }
  };

  return (
    <div className="rounded-2xl border border-[#2f2f2f] bg-[#171717] p-5 space-y-5">
      <div>
        <h3 className="text-base font-semibold text-white">Zotero Web API v3 Sync (BYOK)</h3>
        <p className="mt-1 text-xs text-[#8e8e8e]">
          Pull metadata directly from your Zotero user or group library into this workspace. Public libraries work without a key; private libraries accept a read-only Zotero API key in your browser session (never stored).
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <select
            aria-label="Zotero library type"
            value={libraryType}
            onChange={(e) => setLibraryType(e.target.value as ZoteroLibraryType)}
            className="rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white"
          >
            <option value="users">User library</option>
            <option value="groups">Group library</option>
          </select>
          <input
            value={libraryId}
            onChange={(e) => setLibraryId(e.target.value)}
            placeholder="Numeric library ID (e.g. 1234567)"
            className="rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
          />
          <input
            value={collectionKey}
            onChange={(e) => setCollectionKey(e.target.value)}
            placeholder="Collection key (optional)"
            className="rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Read-only API key (optional)"
            className="rounded-xl border border-[#2f2f2f] bg-black px-3 py-2 text-sm text-white placeholder:text-[#5f5f5f]"
          />
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={busy || !libraryId.trim()}
            onClick={() => void handleSync()}
            className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-[#e5e5e5]"
          >
            {busy ? "Syncing Zotero…" : "Pull Zotero references"}
          </button>
          {status && <span className="text-xs text-[#86efac]">{status}</span>}
          {error && <span className="text-xs text-[#fca5a5]">{error}</span>}
        </div>
      </div>

      <div className="border-t border-[#2f2f2f] pt-4">
        <div className="text-sm font-semibold text-white">1-Click Browser Web Clipper Bookmarklet</div>
        <p className="mt-1 text-xs text-[#8e8e8e]">
          Drag the button below to your browser bookmarks bar (or copy the bookmarklet URL). Clicking it on publisher or repository pages captures the page DOI, title, and URL into Quick Add.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={bookmarkletHref}
            onClick={(e) => e.preventDefault()}
            draggable
            className="rounded-xl border border-[#3f3f46] bg-[#27272a] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#3f3f46] cursor-grab"
          >
            Clip to Research Workbench
          </a>
          <button
            type="button"
            onClick={() => void copyClipper()}
            className="rounded-xl border border-[#2f2f2f] bg-black px-3.5 py-2 text-xs text-[#d4d4d4] hover:text-white"
          >
            {copiedClipper ? "Copied bookmarklet" : "Copy bookmarklet URL"}
          </button>
        </div>
      </div>
    </div>
  );
}
