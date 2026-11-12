"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useSession } from "@/contexts/SessionContext";
import { TracePanel } from "@/components/TracePanel";
import { Panel, buttonClass } from "@/components/ui/Panel";
import { downloadText } from "@/lib/browser/download";
import { createClient } from "@/lib/supabase/client";
import { getWorkspaceId } from "@/lib/wb/library";
import { buildWorkspaceExport } from "@/lib/wb/export";

type Health = Awaited<ReturnType<typeof api.health>>;

/** Workspace membership + the (read-only) admin entry point. */
export function WorkspaceCard() {
  const { workspace } = useSession();

  return (
    <Panel
      title="Workspace"
      description={
        workspace ? (
          <>
            Member of <span className="text-white">{workspace.name}</span> as{" "}
            <span className="text-white">{workspace.role}</span>.
          </>
        ) : (
          "No workspace."
        )
      }
    >
      <p className="mt-1 text-xs leading-relaxed text-[#8e8e8e]">
        Member management, the member limit and the upload approval queue live in the admin dashboard.
      </p>
      <div className="mt-3">
        <Link href="/admin" className={`${buttonClass} inline-block`}>
          Open admin dashboard
        </Link>
      </div>
    </Panel>
  );
}

/** Backend health snapshot, workspace export and the local trace panel. */
export function StorageCard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportWarning, setExportWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const exportWorkspace = async () => {
    setExporting(true);
    setExportWarning(null);
    try {
      const ws = await getWorkspaceId();
      // Bounded + column-trimmed (see lib/wb/export): documents exclude the
      // fts tsvector and page through in 1000-row ranges; large workspaces
      // warn and split into parts instead of one giant file.
      const result = await buildWorkspaceExport(createClient(), ws);
      if (result.warned) setExportWarning(result.warning);
      for (const part of result.parts) {
        downloadText(JSON.stringify(part.data, null, 2), part.filename, "application/json");
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel
      title="Storage"
      description={
        <>
          Supabase is the source of truth: <span className="font-mono text-white">Postgres</span> for metadata/chats/research,{" "}
          <span className="font-mono text-white">Storage (documents bucket)</span> for files,{" "}
          <span className="font-mono text-white">pgvector</span> for embeddings.
        </>
      }
    >
      {health ? (
        <div className="mt-3 overflow-auto rounded-xl border border-[#2f2f2f] bg-black p-3 font-mono text-xs whitespace-pre-wrap break-all text-[#8e8e8e]">
          {JSON.stringify(health, null, 2)}
        </div>
      ) : null}
      <button onClick={exportWorkspace} disabled={exporting} className={`${buttonClass} mt-3`}>
        {exporting ? "Exporting…" : "Export workspace JSON"}
      </button>
      {exportWarning ? <div className="mt-2 text-xs text-amber-400">{exportWarning}</div> : null}
      <TracePanel />
    </Panel>
  );
}

/** Local-first guarantee, written once on the page people check it. */
export function PrivacyCard() {
  return (
    <Panel title="Privacy">
      <p className="mt-2 text-sm leading-relaxed text-[#b4b4b4]">
        <b className="text-white">Local-first inference.</b> With the Ollama provider, prompts, documents and embeddings never
        leave this device — Supabase only stores the shared library and research artifacts. Cloud features (BYOK proxy, OpenAlex
        metadata lookup) are per-member and opt-in.
      </p>
    </Panel>
  );
}

/** Stable UI behaviours users can rely on; no state, no hooks. */
export function ShortcutsCard() {
  return (
    <Panel title="Keyboard shortcuts & states">
      <ul className="mt-2 ml-5 list-disc space-y-1 text-sm text-[#b4b4b4]">
        <li>
          <span className="font-mono text-white">/</span> focuses search
        </li>
        <li>Upload shows live phases: Analyzing → Uploading → Embedding → pending approval</li>
        <li>
          Error recovery: embedding failure marks the row <span className="font-mono text-white">error</span> — delete and re-upload
          once Ollama is healthy
        </li>
        <li>Empty/loading/error states are present on every view</li>
        <li>Research chat history persists per conversation on this device; shared threads live in Chats</li>
        <li>
          Inference runs on <span className="font-mono text-white">your own provider</span> (Ollama local or your cloud key) — never
          shared
        </li>
      </ul>
    </Panel>
  );
}
