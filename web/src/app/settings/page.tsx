"use client";
import { useEffect, useState } from "react";
import Topbar from "@/components/Topbar";
import { api } from "@/lib/api";

export default function SettingsPage(){
  const [settings, setSettings] = useState<any>({});
  const [health, setHealth] = useState<any>(null);
  const [chatCfg, setChatCfg] = useState<any>(null);
  const [chatForm, setChatForm] = useState<any>({ chat_model:"", chat_num_ctx:"", chat_ctx_safety_margin:"", chat_temperature:"", chat_num_predict:"" });
  const [saving, setSaving] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
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
  const [watch, setWatch] = useState<any>(null);
  const load = async()=>{
    const [s, h, c] = await Promise.all([api.settings(), api.health(), api.config().catch(()=>null)]);
    setSettings(s);
    setHealth(h);
    if(c){
      setChatCfg(c);
      setChatForm({
        chat_model: c.chat?.model ?? c.rag_model ?? "",
        chat_num_ctx: String(c.chat?.num_ctx ?? ""),
        chat_ctx_safety_margin: String(c.chat?.ctx_safety_margin ?? ""),
        chat_temperature: String(c.chat?.temperature ?? ""),
        chat_num_predict: c.chat?.num_predict != null ? String(c.chat.num_predict) : "",
      });
    }
    api.citationStyles().then(r=>{ setCiteStyles(r.styles||[]); setCiteDefault(r.default||"apa"); }).catch(()=>{});
    api.watchStatus().then(setWatch).catch(()=>{});
  };
  useEffect(()=>{ load(); },[]);
  const save = async()=>{
    setSaving(true);
    try{ const r=await api.updateSettings(settings); setSettings(r); } finally{ setSaving(false); }
  };
  const saveChat = async()=>{
    setChatSaving(true);
    try{
      const payload: any = {};
      // only send non-empty or explicitly cleared values
      // For model: empty means clear override (use default)
      payload.chat_model = (chatForm.chat_model ?? "").trim();
      payload.chat_num_ctx = (chatForm.chat_num_ctx ?? "").trim();
      payload.chat_ctx_safety_margin = (chatForm.chat_ctx_safety_margin ?? "").trim();
      payload.chat_temperature = (chatForm.chat_temperature ?? "").trim();
      payload.chat_num_predict = (chatForm.chat_num_predict ?? "").trim();
      const r = await api.updateConfig(payload);
      setChatCfg(r);
      // refresh form with returned effective values
      setChatForm({
        chat_model: r.chat?.model ?? "",
        chat_num_ctx: String(r.chat?.num_ctx ?? ""),
        chat_ctx_safety_margin: String(r.chat?.ctx_safety_margin ?? ""),
        chat_temperature: String(r.chat?.temperature ?? ""),
        chat_num_predict: r.chat?.num_predict != null ? String(r.chat.num_predict) : "",
      });
    } catch(e:any){ alert(e.message); }
    finally{ setChatSaving(false); }
  };
  const resetChat = async()=>{
    if(!confirm("Reset chat settings to defaults (gemma4:26b-a4b-it-qat, 32k context)?")) return;
    setChatSaving(true);
    try{
      const r = await api.updateConfig({ chat_model:"", chat_num_ctx:"", chat_ctx_safety_margin:"", chat_temperature:"", chat_num_predict:"" });
      setChatCfg(r);
      setChatForm({
        chat_model: r.chat?.model ?? "gemma4:26b-a4b-it-qat",
        chat_num_ctx: String(r.chat?.num_ctx ?? 32768),
        chat_ctx_safety_margin: String(r.chat?.ctx_safety_margin ?? 800),
        chat_temperature: String(r.chat?.temperature ?? 0),
        chat_num_predict: r.chat?.num_predict != null ? String(r.chat.num_predict) : "2048",
      });
    } catch(e:any){ alert(e.message); } finally{ setChatSaving(false); }
  };
  const backup = async()=>{
    const r = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"}/api/backup`, { method:"POST" }).then(x=>x.json());
    alert(`Backup created: ${r.filename} at ${r.path}`);
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
      setImportMsg(`Imported ${r.imported} reference(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ""}`);
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

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-black">
      <Topbar title="Settings" subtitle="Model routing • 26B chat tuning • Privacy/offline • Storage • Backup" />
      <div className="px-4 lg:px-6 py-6 max-w-4xl w-full mx-auto space-y-6">
        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Chat — Research Ask (26B)</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            Ollama-only. This controls the model and context used by the <span className="text-white font-mono">Research → Ask</span> chat (RAG). Defaults target <span className="text-white font-mono">gemma4:26b-a4b-it-qat</span> at 32k context. Changes apply on the next question — no restart required.
          </div>
          {chatCfg ? (
            <>
              <div className="mt-3 rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 flex flex-wrap gap-2 text-[11px] font-mono text-[#8e8e8e]">
                <span>model <b className="text-white">{chatCfg.chat?.model ?? chatCfg.rag_model}</b></span>
                <span className="hidden sm:inline text-[#2f2f2f]">•</span>
                <span>num_ctx <b className="text-white">{chatCfg.chat?.num_ctx}</b></span>
                <span className="hidden sm:inline text-[#2f2f2f]">•</span>
                <span>temperature <b className="text-white">{chatCfg.chat?.temperature}</b></span>
                <span className="hidden sm:inline text-[#2f2f2f]">•</span>
                <span>num_predict <b className="text-white">{chatCfg.chat?.num_predict ?? "default"}</b></span>
              </div>
              <div className="grid gap-4 mt-4 grid-cols-1 md:grid-cols-2">
                <label className="text-xs font-medium text-[#ececec]">Chat model (Ollama tag)
                  <input value={chatForm.chat_model} onChange={e=>setChatForm({...chatForm, chat_model: e.target.value})} placeholder="gemma4:26b-a4b-it-qat" className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                  <span className="text-[11px] text-[#5f5f5f]">Must be pulled: <span className="font-mono">ollama pull gemma4:26b-a4b-it-qat</span>. Clear to use default.</span>
                </label>
                <label className="text-xs font-medium text-[#ececec]">Context length — num_ctx
                  <input type="number" value={chatForm.chat_num_ctx} onChange={e=>setChatForm({...chatForm, chat_num_ctx: e.target.value})} placeholder="32768" min={4096} max={131072} step={1024} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                  <span className="text-[11px] text-[#5f5f5f]">Per-request KV cache. 26B supports up to 128k but needs VRAM. 32768 is safe for 24GB.</span>
                </label>
                <label className="text-xs font-medium text-[#ececec]">Safety margin (tokens)
                  <input type="number" value={chatForm.chat_ctx_safety_margin} onChange={e=>setChatForm({...chatForm, chat_ctx_safety_margin: e.target.value})} placeholder="800" min={0} max={4000} step={100} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                  <span className="text-[11px] text-[#5f5f5f]">Reserved headroom so retrieved context never silently truncates.</span>
                </label>
                <label className="text-xs font-medium text-[#ececec]">Temperature (0–2)
                  <input type="number" value={chatForm.chat_temperature} onChange={e=>setChatForm({...chatForm, chat_temperature: e.target.value})} placeholder="0.0" min={0} max={2} step={0.1} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                  <span className="text-[11px] text-[#5f5f5f]">0 = deterministic. 0.7–1.0 for more creative hypotheses.</span>
                </label>
                <label className="text-xs font-medium text-[#ececec]">Max tokens — num_predict (empty = model default)
                  <input type="number" value={chatForm.chat_num_predict} onChange={e=>setChatForm({...chatForm, chat_num_predict: e.target.value})} placeholder="2048" min={256} max={8192} step={256} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" />
                  <span className="text-[11px] text-[#5f5f5f]">Caps answer length. Leave blank for model default.</span>
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={saveChat} disabled={chatSaving} className="rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium disabled:opacity-50">{chatSaving? "Saving…":"Save chat settings"}</button>
                <button onClick={resetChat} disabled={chatSaving} className="rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2.5 text-sm text-white disabled:opacity-50">Reset to defaults</button>
              </div>
            </>
          ) : <div className="mt-3 text-xs text-[#8e8e8e]">Loading chat config…</div>}
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Citation — CSL styles</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            All citations render through one backend CSL engine (citeproc-py) shared by the UI, CLI and exported reports — the app supports the CSL ecosystem, not a hardcoded style list.
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
          <div className="text-xs text-[#8e8e8e] mt-1">Interoperate with existing tools: Zotero → RIS export → import here → research → export BibTeX → LaTeX.</div>
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
          <div className="text-sm font-semibold text-white">Watch-Folder Automation</div>
          <div className="text-xs text-[#8e8e8e] mt-1">
            When enabled, <span className="font-mono text-white">pfolder/</span> is polled every 30s — new PDFs dropped there are auto-indexed without restarting or clicking Reindex. Works while the backend is running.
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className={`h-2 w-2 rounded-full ${watch?.enabled ? "bg-emerald-400 animate-pulse" : "bg-[#5f5f5f]"}`} />
            <span className="text-sm text-white">{watch ? (watch.enabled ? "Watching" : "Paused") : "Loading…"}</span>
            {watch && <span className="text-xs font-mono text-[#5f5f5f]">{watch.watching} • {watch.alive ? "polling" : "stopped"}</span>}
            <button onClick={async()=>{ const r=await api.watchToggle(); setWatch(r); }} className="ml-auto rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">{watch?.enabled ? "Pause" : "Enable"}</button>
          </div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Model configuration</div>
          <div className="text-xs text-[#8e8e8e]">Advanced: embeddings and auto-organize thresholds. Changing embeddings requires reindex.</div>
          <div className="grid gap-4 mt-4 grid-cols-1 md:grid-cols-2">
            {[
              ["embedding_provider","Embedding provider"],
              ["embedding_model","Embedding model"],
              ["auto_organize_threshold_high","Auto-organize high threshold"],
              ["auto_organize_threshold_low","Auto-organize low threshold"],
              ["strict_offline_mode","Strict offline mode (true/false)"],
            ].map(([key,label])=>(
              <label key={key} className="text-xs font-medium text-[#ececec]">{label}<input value={settings[key]||""} onChange={e=>setSettings({...settings, [key]: e.target.value})} className="mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white" /></label>
            ))}
          </div>
          <button onClick={save} disabled={saving} className="mt-4 rounded-xl bg-white text-black px-5 py-2.5 text-sm font-medium disabled:opacity-50">{saving? "Saving…":"Save settings"}</button>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Privacy / Offline</div>
          <div className="mt-2 text-sm text-[#b4b4b4] leading-relaxed">
            <b className="text-white">Strict offline mode</b> blocks all network requests except localhost. This disables metadata lookups but keeps parsing, retrieval, and local LLM inference working.
            Set <span className="font-mono text-white">strict_offline_mode=true</span> above and restart the backend.
          </div>
          <div className="mt-3 text-xs text-[#8e8e8e]">Current: {settings.strict_offline_mode === "true" ? "🔒 Strict offline ON" : "🌐 Online"}</div>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Storage</div>
          <div className="text-sm text-[#b4b4b4] mt-1 break-words">SQLite is source of truth at <span className="font-mono text-white">research_workbench/data/library.db</span>. Filesystem originals at <span className="font-mono text-white">research_workbench/data/documents/</span>. Chroma at <span className="font-mono text-white">chroma_db/</span>.</div>
          {health && <div className="mt-3 text-xs font-mono bg-black border border-[#2f2f2f] rounded-xl p-3 whitespace-pre-wrap break-all text-[#8e8e8e]">{JSON.stringify(health, null, 2)}</div>}
          {chatCfg && <div className="mt-3 text-xs font-mono bg-black border border-[#2f2f2f] rounded-xl p-3 whitespace-pre-wrap break-all text-[#8e8e8e]">{JSON.stringify(chatCfg, null, 2)}</div>}
          <button onClick={backup} className="mt-3 rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white">Create backup</button>
        </div>

        <div className="rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5">
          <div className="text-sm font-semibold text-white">Keyboard shortcuts & states</div>
          <ul className="mt-2 text-sm text-[#b4b4b4] list-disc ml-5 space-y-1">
            <li><span className="font-mono text-white">/</span> focuses search</li>
            <li>Upload queue shows per-file progress: Parsed → Metadata → Classified → Organized → Embedding → Ready</li>
            <li>Error recovery: embedding failure → Retry; incomplete metadata → Edit metadata; low confidence → Choose collection manually</li>
            <li>Empty/loading/error states are present on every view</li>
            <li>Chat history persists across navigation via localStorage + context</li>
            <li>Ollama-only: all roles run via <span className="font-mono text-white">ollama</span> (chat uses <span className="font-mono text-white">gemma4:26b-a4b-it-qat</span> by default)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
