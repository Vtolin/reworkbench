"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Topbar from "@/components/Topbar";
import { api, readInference } from "@/lib/api";
import { useInference } from "@/contexts/InferenceContext";
import { useSession } from "@/contexts/SessionContext";
import { detectOllamaModels } from "@/lib/ollama/detect";
import { createClient } from "@/lib/supabase/client";
import { getWorkspaceId } from "@/lib/wb/library";

export default function SettingsPage(){
  const [settings, setSettings] = useState<any>({});
  const [health, setHealth] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const { settings: inf, setSettings: setInf, ollamaModels, refreshOllamaModels, ollamaOnline } = useInference();
  const { workspace } = useSession();
  // Citation + import/export state
  const [citeStyles, setCiteStyles] = useState<any[]>([]);
  const [citeDefault, setCiteDefault] = useState("apa");
  const [citeFetch, setCiteFetch] = useState("");
  const [citeCustomXml, setCiteCustomXml] = useState("");
  const [citeMsg, setCiteMsg] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [cloudKey, setCloudKey] = useState("");
  const [cloudMsg, setCloudMsg] = useState<string | null>(null);
  const [cloudModels, setCloudModels] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<string[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = async()=>{
    const [s, h] = await Promise.all([api.settings(), api.health().catch(()=>null)]);
    setSettings(s);
    setHealth(h);
    api.citationStyles().then(r=>{ setCiteStyles(r.styles||[]); setCiteDefault(r.default||"apa"); }).catch(()=>{});
  };
  useEffect(()=>{ load(); },[]);
  const save = async()=>{
    setSaving(true);
    try{ const r=await api.updateSettings(settings); setSettings(r); } finally{ setSaving(false); }
  };

  const detect = async () => {
    setDetecting(true);
    const { models } = await detectOllamaModels();
    setDetected(models);
    await refreshOllamaModels();
    setDetecting(false);
  };

  const saveCloudKey = async () => {
    if (!cloudKey) return;
    const res = await fetch("/api/ai/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: inf.cloudProvider, apiKey: cloudKey }),
    });
    if (res.ok) {
      setCloudMsg("Key saved (encrypted at rest, owner-only — never shared). Now press ↻ Models to list.");
      setCloudKey("");
    } else {
      const d = await res.json().catch(() => ({}));
      setCloudMsg((d as any).error ?? "Save failed");
    }
  };

  const removeCloudKey = async () => {
    if (!confirm("Forget your saved cloud API key on this workspace? (This does not revoke it at the provider — rotate it there too.)")) return;
    const res = await fetch("/api/ai/proxy", { method: "DELETE" });
    if (res.ok) {
      setCloudKey("");
      setCloudModels(null);
      setCloudMsg("Saved key removed from the app. Rotate it in the provider dashboard to fully revoke.");
    } else {
      const d = await res.json().catch(() => ({}));
      setCloudMsg((d as any).error ?? "Remove failed");
    }
  };

  const fetchCloudModels = async () => {    setFetchingModels(true);
    try {
      const { listCloudModels } = await import("@/lib/ai/cloud");
      const models = await listCloudModels(inf.cloudProvider);
      setCloudModels(models);
      setCloudMsg(models.length ? null : "No models returned — check the key.");
    } catch (e) {
      setCloudMsg(e instanceof Error ? e.message : "Model list failed (save your key first).");
      setCloudModels(null);
    } finally {
      setFetchingModels(false);
    }
  };

  const setDefaultStyle = async(style: string)=>{
    setCiteDefault(style);
    try{ await api.citationStyleDefault(style); setCiteMsg("Default saved"); } catch(e:any){ setCiteMsg(e.message); }
  };
  const fetchStyle = async()=>{
    try{
      const r = await api.citationStyleFetch(citeFetch);
      setCiteStyles(r.styles||[]);
      setCiteMsg(`Fetched: ${r.style.title}`);
    } catch(e:any){ setCiteMsg(e.message); }
  };
  const addCustomStyle = async()=>{
    try{
      const r = await api.citationStyleCustom(citeCustomXml);
      setCiteStyles(r.styles||[]);
      setCiteMsg("Custom style added — select 'Custom CSL' above");
    } catch(e:any){ setCiteMsg(e.message); }
  };
  const doImport = async()=>{
    setImportBusy(true); setImportMsg(null);
    try{
      const r = await api.importRefs(importText, importFormat || undefined);
      setImportMsg(`Imported ${r.imported} reference(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""} — pending admin approval`);
      setImportText("");
    } catch(e:any){ setImportMsg(e.message); }
    finally{ setImportBusy(false); }
  };
  const download = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  const doExport = async(format: string)=>{
    const r = await api.exportRefs(format);
    download(r.data, `library.${format === "csl-json" ? "json" : format === "ris" ? "ris" : "bib"}`,
             format === "csl-json" ? "application/json" : "text/plain");
  };
  const doExportBibliography = async()=>{
    const r = await api.exportBibliography(citeDefault);
    download(r.bibliography.join("\n\n"), `bibliography-${citeDefault}.txt`, "text/plain");
  };
  const exportWorkspace = async()=>{
    setExporting(true);
    try{
      const ws = await getWorkspaceId();
      const sb = createClient();
      const tables = ["documents","collections","tags","authors","research_projects","claims","citations","evidence_items","annotations","research_trail","saved_searches","chats","chat_messages"];
      const dump: Record<string, unknown> = { workspace_id: ws, exported_at: new Date().toISOString() };
      for (const t of tables) {
        const key = t === "documents" ? "workspace_id" : "workspace_id";
        const { data } = await sb.from(t).select("*").eq(key, ws).limit(5000);
        dump[t] = data ?? [];
      }
      download(JSON.stringify(dump, null, 2), `workbench-export-${ws.slice(0,8)}.json`, "application/json");
    } finally{ setExporting(false); }
  };

  const infSnap = readInference();

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Settings" subtitle="Inference (this device) • Citation • Import/export • Workspace • Storage" />
      <div className="px-4 lg:px-6 py-6 max-w-4xl w-full mx-auto space-y-6">
        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Chat — inference on this device</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            Model choice, context length, temperature and keys are <span className="text-white">local/browser state</span> — never shared with the workspace.
            This controls the model used by <span className="text-white font-mono">Research → Ask</span>, document Q&A and synthesis. Changes apply on the next question — no restart required.
          </div>
          <div className="mt-3 rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 flex flex-wrap gap-2 text-[11px] font-mono text-[#8e8e8e]">
            <span>provider <b className="text-white">{inf.provider}</b></span>
            <span className="hidden sm:inline text-[#2f2f2f]">•</span>
            <span>model <b className="text-white">{inf.provider === "ollama" ? inf.model : inf.cloudModel}</b></span>
            <span className="hidden sm:inline text-[#2f2f2f]">•</span>
            <span>num_ctx <b className="text-white">{inf.numCtx}</b></span>
            <span className="hidden sm:inline text-[#2f2f2f]">•</span>
            <span>temperature <b className="text-white">{inf.temperature}</b></span>
            <span className="hidden sm:inline text-[#2f2f2f]">•</span>
            <span>ollama <b className="text-white">{ollamaOnline ? `online (${ollamaModels.length} models)` : "offline"}</b></span>
          </div>
          <div className="grid gap-4 mt-4 grid-cols-1 md:grid-cols-2">
            <label className="text-xs font-medium text-[#ececec]">Provider
              <select value={inf.provider} onChange={e=>setInf({ provider: e.target.value as "ollama" | "cloud" })} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                <option value="ollama">Ollama (local, private)</option>
                <option value="cloud">Cloud (my own key)</option>
              </select>
              <span className="text-[11px] text-[#5f5f5f]">Local = zero server-side inference. Cloud = proxied with your personal key.</span>
            </label>
            <label className="text-xs font-medium text-[#ececec]">Ollama model tag
              <input value={inf.model} onChange={e=>setInf({ model: e.target.value })} list="ollama-models" placeholder="gemma4:26b-a4b-it-qat" className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
              <datalist id="ollama-models">{ollamaModels.map(m=> <option key={m} value={m} />)}</datalist>
              <span className="text-[11px] text-[#5f5f5f]">Must be pulled: <span className="font-mono">ollama pull gemma4:26b-a4b-it-qat</span>.</span>
            </label>
            <label className="text-xs font-medium text-[#ececec]">Context length — num_ctx
              <input type="number" value={inf.numCtx} onChange={e=>setInf({ numCtx: Number(e.target.value) })} placeholder="32768" min={4096} max={131072} step={1024} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
              <span className="text-[11px] text-[#5f5f5f]">Per-request KV cache. Lower (e.g. 8192) if you hit OOM on big models.</span>
            </label>
            <label className="text-xs font-medium text-[#ececec]">Temperature (0–2)
              <input type="number" value={inf.temperature} onChange={e=>setInf({ temperature: Number(e.target.value) })} placeholder="0.0" min={0} max={2} step={0.1} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
              <span className="text-[11px] text-[#5f5f5f]">0 = deterministic. 0.7–1.0 for more creative hypotheses.</span>
            </label>
            <label className="text-xs font-medium text-[#ececec]">Embedding mode
              <select value={inf.embedMode} onChange={e=>setInf({ embedMode: e.target.value as "local" | "server" })} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                <option value="local">Local (Ollama nomic-embed-text, private)</option>
                <option value="server">Server (cloud embedding API, my key)</option>
              </select>
              <span className="text-[11px] text-[#5f5f5f]">Used for uploads and query embeddings on this device.</span>
            </label>
            <div className="text-xs font-medium text-[#ececec]">Installed models
              <div className="mt-1">
                <button onClick={detect} disabled={detecting} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white disabled:opacity-50">{detecting ? "Detecting…" : "Auto-detect Ollama models"}</button>
                {detected && <div className="mt-1 text-[11px] text-[#8e8e8e] break-all">{detected.join(", ") || "none found — is 'ollama serve' running?"}</div>}
              </div>
            </div>
          </div>
          <div className="mt-4 border-t border-[#2f2f2f] pt-4 text-xs font-medium text-[#ececec]">Cloud provider (BYOK — personal, never shared)
            <div className="flex flex-wrap gap-2 mt-2">
              <select value={inf.cloudProvider} onChange={e=>{ setInf({ cloudProvider: e.target.value as "openai" | "anthropic" | "google" | "deepseek" }); setCloudModels(null); }} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="google">Google</option>
                <option value="anthropic">Anthropic</option>
              </select>
              <input value={inf.cloudModel} onChange={e=>setInf({ cloudModel: e.target.value })} list="cloud-models" placeholder="Model (e.g. deepseek-chat)" className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
              <datalist id="cloud-models">{(cloudModels ?? []).map(m=> <option key={m} value={m} />)}</datalist>
              <button onClick={fetchCloudModels} disabled={fetchingModels} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-3 py-2 text-sm text-white disabled:opacity-50" title="List models from the provider using your saved key">
                {fetchingModels ? "…" : "↻ Models"}
              </button>
              <input value={cloudKey} onChange={e=>setCloudKey(e.target.value)} type="password" placeholder="Paste API key (encrypted server-side)" className="min-w-64 flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
              <button onClick={saveCloudKey} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Save key</button>
              <button onClick={removeCloudKey} className="rounded-xl border border-red-900/50 bg-[#171717] px-4 py-2 text-sm text-red-400 hover:bg-red-950/30">Remove key</button>
            </div>
            {cloudModels && <div className="mt-1 text-[11px] text-[#8e8e8e] break-all">{cloudModels.length ? `${cloudModels.length} models from provider` : "No models returned"}</div>}
            {cloudMsg && <div className="mt-2 text-[11px] text-[#8e8e8e]">{cloudMsg}</div>}
            <div className="mt-1 text-[11px] text-[#5f5f5f]">Effective: model {infSnap.model} • ctx {infSnap.numCtx} • temp {infSnap.temperature}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Summarization pipeline</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            <span className="text-white">Single pass</span> stitches the doc into one prompt with the chat model.
            <span className="text-white"> Map→reduce</span> extracts each chunk with the map model, then combines with the reduce model —
            slower but handles long docs. Cross-paper synthesis uses the synthesis model. Progress shows per chunk (<span className="font-mono">Extracting 1/20 chunks</span>).
          </div>
          <label className="block text-xs font-medium text-[#ececec] mt-4">Method
            <select value={inf.summarizeMethod ?? "stuff"} onChange={e=>setInf({ summarizeMethod: e.target.value as "stuff" | "map_reduce" })} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
              <option value="stuff">Single pass (chat model)</option>
              <option value="map_reduce">Map → reduce (per-chunk)</option>
            </select>
          </label>
          {[["mapStage","Map — per-chunk extraction"],["reduceStage","Reduce — combining + final summary"],["synthesisStage","Synthesis — cross-paper"]].map(([key,label])=>{
            const st = (inf as any)[key] ?? { provider: "inherit", model: "", cloudProvider: inf.cloudProvider, cloudModel: "" };
            const set = (patch: Record<string, string>) => setInf({ [key]: { ...st, ...patch } } as any);
            return (
              <div key={key} className="mt-4 border-t border-[#2f2f2f] pt-3">
                <div className="text-xs font-medium text-[#ececec]">{label}
                  <span className="ml-2 text-[11px] text-[#5f5f5f] font-normal">
                    {st.provider === "inherit" ? "using chat model" : st.provider === "ollama" ? `ollama:${st.model || inf.model}` : `${st.cloudProvider}:${st.cloudModel || inf.cloudModel}`}
                  </span>
                </div>
                <div className="grid gap-3 mt-2 grid-cols-1 md:grid-cols-3">
                  <label className="text-xs text-[#8e8e8e]">Provider
                    <select value={st.provider} onChange={e=>set({ provider: e.target.value })} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                      <option value="inherit">Inherit chat model</option>
                      <option value="ollama">Ollama</option>
                      <option value="cloud">Cloud</option>
                    </select>
                  </label>
                  {st.provider === "ollama" && (
                    <label className="text-xs text-[#8e8e8e]">Ollama model
                      <input value={st.model} onChange={e=>set({ model: e.target.value })} list="ollama-models" placeholder={inf.model} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                    </label>
                  )}
                  {st.provider === "cloud" && (<>
                    <label className="text-xs text-[#8e8e8e]">Cloud provider
                      <select value={st.cloudProvider} onChange={e=>set({ cloudProvider: e.target.value })} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                        <option value="openai">OpenAI</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="google">Google</option>
                        <option value="anthropic">Anthropic</option>
                      </select>
                    </label>
                    <label className="text-xs text-[#8e8e8e]">Cloud model
                      <input value={st.cloudModel} onChange={e=>set({ cloudModel: e.target.value })} list="cloud-models" placeholder={inf.cloudModel} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                    </label>
                  </>)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Citation — CSL styles</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            All citations render through one shared CSL engine (citeproc-js, same vendored styles) — the app supports the CSL ecosystem, not a hardcoded style list.
          </div>
          <div className="grid gap-4 mt-4 grid-cols-1 md:grid-cols-2">
            <label className="text-xs font-medium text-[#ececec]">Default style
              <select value={citeDefault} onChange={e=>setDefaultStyle(e.target.value)} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                {citeStyles.map((s:any)=> <option key={s.id} value={s.id} className="bg-[#171717]">{s.title}</option>)}
              </select>
            </label>
            <div className="text-xs font-medium text-[#ececec]">Fetch style from the CSL repository (e.g. ieee, vancouver)
              <div className="flex gap-2 mt-1">
                <input value={citeFetch} onChange={e=>setCiteFetch(e.target.value)} placeholder="style id…" className="flex-1 rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                <button onClick={fetchStyle} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Fetch</button>
              </div>
            </div>
          </div>
          <div className="mt-4 text-xs font-medium text-[#ececec]">Add CSL style (paste raw XML)
            <textarea value={citeCustomXml} onChange={e=>setCiteCustomXml(e.target.value)} rows={4} placeholder="<style xmlns=...>...</style>" className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white font-mono" />
            <button onClick={addCustomStyle} className="mt-2 rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Add custom style</button>
          </div>
          {citeMsg && <div className="mt-3 text-xs text-[#8e8e8e]">{citeMsg}</div>}
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Import / Export</div>
          <div className="text-xs text-[#8e8e8e] mt-1">Interoperate with existing tools: Zotero → RIS export → import here → research → export BibTeX → LaTeX. Imports land as pending records for admin approval.</div>
          <div className="mt-4 text-xs font-medium text-[#ececec]">One-Click Importer — file upload (preserves collections)
            <div className="mt-2 flex flex-wrap gap-2 items-center">
              <label className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white cursor-pointer hover:bg-[#2f2f2f]">
                Choose BibTeX/RIS file
                <input type="file" accept=".bib,.ris,.xml,.json" className="hidden" onChange={async e=>{
                  const f = e.target.files?.[0];
                  if(!f) return;
                  setImportBusy(true); setImportMsg(null);
                  try{
                    const r = await api.importFile(f);
                    setImportMsg(`Imported ${r.imported} reference(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""} — collections preserved`);
                  } catch(err:any){ setImportMsg(err.message); }
                  finally{ setImportBusy(false); e.target.value=""; }
                }} />
              </label>
              <span className="text-[#5f5f5f]">or paste below</span>
            </div>
          </div>
          <div className="mt-4 text-xs font-medium text-[#ececec]">Import references (paste text — BibTeX / RIS / EndNote XML / CSL-JSON)
            <textarea value={importText} onChange={e=>setImportText(e.target.value)} rows={6} placeholder="@article{key, ...}   or   TY  - JOUR ..." className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white font-mono" />
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <select value={importFormat} onChange={e=>setImportFormat(e.target.value)} className="rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white">
                <option value="">Auto-detect</option>
                <option value="bibtex">BibTeX</option>
                <option value="ris">RIS</option>
                <option value="endnote-xml">EndNote XML</option>
                <option value="csl-json">CSL-JSON</option>
              </select>
              <button onClick={doImport} disabled={importBusy} className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium disabled:opacity-50">{importBusy ? "Importing…" : "Import pasted"}</button>
            </div>
            {importMsg && <div className="mt-2 text-[#8e8e8e]">{importMsg}</div>}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={()=>doExport("bibtex")} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Export BibTeX</button>
            <button onClick={()=>doExport("ris")} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Export RIS</button>
            <button onClick={()=>doExport("csl-json")} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Export CSL-JSON</button>
            <button onClick={doExportBibliography} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Export bibliography ({citeDefault})</button>
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Workspace</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            {workspace ? <>Member of <span className="text-white">{workspace.name}</span> as <span className="text-white">{workspace.role}</span>.</> : "No workspace."} Member management, the member limit and the upload approval queue live in the admin dashboard.
          </div>
          <div className="mt-3">
            <Link href="/admin" className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white inline-block">Open admin dashboard</Link>
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Model configuration</div>
          <div className="text-xs text-[#8e8e8e]">Advanced: embeddings and auto-organize thresholds. Changing the embedding model requires re-embedding documents.</div>
          <div className="grid gap-4 mt-4 grid-cols-1 md:grid-cols-2">
            {[
              ["embedding_provider","Embedding provider"],
              ["embedding_model","Embedding model"],
              ["auto_organize_threshold_high","Auto-organize high threshold"],
              ["auto_organize_threshold_low","Auto-organize low threshold"],
            ].map(([key,label])=>(
              <label key={key} className="text-xs font-medium text-[#ececec]">{label}<input value={settings[key]||""} onChange={e=>setSettings({...settings, [key]: e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
            ))}
          </div>
          <button onClick={save} disabled={saving} className="mt-4 rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium disabled:opacity-50">{saving? "Saving…":"Save settings"}</button>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Privacy</div>
          <div className="mt-2 text-sm text-[#b4b4b4] leading-relaxed">
            <b className="text-white">Local-first inference.</b> With the Ollama provider, prompts, documents and embeddings never leave this device — Supabase only stores the shared library and research artifacts. Cloud features (BYOK proxy, OpenAlex metadata lookup) are per-member and opt-in.
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Storage</div>
          <div className="text-sm text-[#b4b4b4] mt-1 break-words">Supabase is the source of truth: <span className="font-mono text-white">Postgres</span> for metadata/chats/research, <span className="font-mono text-white">Storage (documents bucket)</span> for files, <span className="font-mono text-white">pgvector</span> for embeddings.</div>
          {health && <div className="mt-3 text-xs font-mono bg-black border border-[#2f2f2f] rounded-xl p-3 whitespace-pre-wrap break-all text-[#8e8e8e]">{JSON.stringify(health, null, 2)}</div>}
          <button onClick={exportWorkspace} disabled={exporting} className="mt-3 rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white disabled:opacity-50">{exporting ? "Exporting…" : "Export workspace JSON"}</button>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Keyboard shortcuts & states</div>
          <ul className="mt-2 text-sm text-[#b4b4b4] list-disc ml-5 space-y-1">
            <li><span className="font-mono text-white">/</span> focuses search</li>
            <li>Upload shows live phases: Analyzing → Uploading → Embedding → pending approval</li>
            <li>Error recovery: embedding failure marks the row <span className="font-mono text-white">error</span> — delete and re-upload once Ollama is healthy</li>
            <li>Empty/loading/error states are present on every view</li>
            <li>Research chat history persists per conversation on this device; shared threads live in Chats</li>
            <li>Inference runs on <span className="font-mono text-white">your own provider</span> (Ollama local or your cloud key) — never shared</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
