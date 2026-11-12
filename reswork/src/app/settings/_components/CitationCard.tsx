"use client";

import { useState } from "react";
import { Panel, buttonClass, fieldClass } from "@/components/ui/Panel";
import type { CitationSettings } from "./useCitationSettings";

/**
 * CSL default style, on-demand repository fetch, and custom XML.
 * Style state is owned by useCitationSettings so the Import/Export card
 * exports with exactly the style shown here.
 */
export function CitationCard({ settings }: { settings: CitationSettings }) {
  const [fetchId, setFetchId] = useState("");
  const [customXml, setCustomXml] = useState("");

  const fetchStyle = async () => {
    try {
      await settings.fetchStyle(fetchId);
    } catch (e) {
      settings.setMessage(e instanceof Error ? e.message : "Could not fetch style");
    }
  };

  const addCustomStyle = async () => {
    try {
      await settings.addCustomStyle(customXml);
    } catch (e) {
      settings.setMessage(e instanceof Error ? e.message : "Could not add custom style");
    }
  };

  return (
    <Panel
      title="Citation — CSL styles"
      description="All citations render through one shared CSL engine (citeproc-js, same vendored styles) — the app supports the CSL ecosystem, not a hardcoded style list."
    >
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="text-xs font-medium text-[#ececec]">
          Default style
          <select
            value={settings.defaultStyle}
            onChange={(e) => void settings.setDefaultStyle(e.target.value)}
            className={fieldClass}
          >
            {settings.styles.map((s) => (
              <option key={s.id} value={s.id} className="bg-[#171717]">
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <div className="text-xs font-medium text-[#ececec]">
          Fetch style from the CSL repository (e.g. ieee, vancouver)
          <div className="mt-1 flex gap-2">
            <input
              value={fetchId}
              onChange={(e) => setFetchId(e.target.value)}
              placeholder="style id…"
              className={fieldClass}
            />
            <button onClick={fetchStyle} className={buttonClass}>
              Fetch
            </button>
          </div>
        </div>
      </div>
      <div className="mt-4 text-xs font-medium text-[#ececec]">
        Add CSL style (paste raw XML)
        <textarea
          value={customXml}
          onChange={(e) => setCustomXml(e.target.value)}
          rows={4}
          placeholder="<style xmlns=...>...</style>"
          className={`${fieldClass} font-mono`}
        />
        <button onClick={addCustomStyle} className={`${buttonClass} mt-2`}>
          Add custom style
        </button>
      </div>
      {settings.message ? <div className="mt-3 text-xs text-[#8e8e8e]">{settings.message}</div> : null}
    </Panel>
  );
}
