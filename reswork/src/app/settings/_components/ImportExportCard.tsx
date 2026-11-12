"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { downloadText } from "@/lib/browser/download";
import { Panel, buttonClass, fieldClass } from "@/components/ui/Panel";

/** Reference import/export (BibTeX, RIS, EndNote XML, CSL-JSON). */
export function ImportExportCard({ defaultStyle }: { defaultStyle: string }) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const doImport = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.importRefs(text, format || undefined);
      setMessage(
        `Imported ${r.imported} reference(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""} — pending admin approval`,
      );
      setText("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const doImportFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.importFile(file);
      setMessage(`Imported ${r.imported} reference(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""} — collections preserved`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (fmt: string) => {
    const r = await api.exportRefs(fmt);
    const ext = fmt === "csl-json" ? "json" : fmt === "ris" ? "ris" : "bib";
    downloadText(r.data, `library.${ext}`, fmt === "csl-json" ? "application/json" : "text/plain");
  };

  const doExportBibliography = async () => {
    const r = await api.exportBibliography(defaultStyle);
    downloadText(r.bibliography.join("\n\n"), `bibliography-${defaultStyle}.txt`, "text/plain");
  };

  return (
    <Panel
      title="Import / Export"
      description="Interoperate with existing tools: Zotero → RIS export → import here → research → export BibTeX → LaTeX. Imports land as pending records for admin approval."
    >
      <div className="mt-4 text-xs font-medium text-[#ececec]">
        One-Click Importer — file upload (preserves collections)
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white hover:bg-[#2f2f2f]">
            Choose BibTeX/RIS file
            <input
              type="file"
              accept=".bib,.ris,.xml,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void doImportFile(file);
              }}
            />
          </label>
          <span className="text-[#5f5f5f]">or paste below</span>
        </div>
      </div>

      <div className="mt-4 text-xs font-medium text-[#ececec]">
        Import references (paste text — BibTeX / RIS / EndNote XML / CSL-JSON)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="@article{key, ...}   or   TY  - JOUR ..."
          className={`${fieldClass} font-mono`}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={format} onChange={(e) => setFormat(e.target.value)} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
            <option value="">Auto-detect</option>
            <option value="bibtex">BibTeX</option>
            <option value="ris">RIS</option>
            <option value="endnote-xml">EndNote XML</option>
            <option value="csl-json">CSL-JSON</option>
          </select>
          <button onClick={doImport} disabled={busy} className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50">
            {busy ? "Importing…" : "Import pasted"}
          </button>
        </div>
        {message ? <div className="mt-2 text-[#8e8e8e]">{message}</div> : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => doExport("bibtex")} className={buttonClass}>
          Export BibTeX
        </button>
        <button onClick={() => doExport("ris")} className={buttonClass}>
          Export RIS
        </button>
        <button onClick={() => doExport("csl-json")} className={buttonClass}>
          Export CSL-JSON
        </button>
        <button onClick={doExportBibliography} className={buttonClass}>
          Export bibliography ({defaultStyle})
        </button>
      </div>
    </Panel>
  );
}
