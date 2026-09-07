"use client";
import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useChat, ChatMessage } from "@/contexts/ChatContext";
import { useInference } from "@/contexts/InferenceContext";
import ChatHistoryPanel from "@/components/ChatHistoryPanel";
import Markdown from "@/components/Markdown";

type Mode = "ask" | "compare" | "summarize" | "matrix" | "synthesis";

function parseThinking(raw: string): { thinking: string | null; answer: string } {
  const lower = raw.toLowerCase();
  const hasOpen = lower.includes("<think>");
  const hasClose = lower.includes("</think>");
  if (hasOpen && !hasClose) {
    const idx = lower.indexOf("<think>");
    const before = raw.slice(0, idx).trim();
    const inner = raw.slice(idx + 7).trim();
    return { thinking: inner || "", answer: before };
  }
  const m = raw.match(/<think>([\s\S]*?)<\/think>/i);
  if (m) {
    const inner = m[1].trim();
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return { thinking: inner || null, answer: cleaned };
  }
  return { thinking: null, answer: raw.trim() };
}

export default function ResearchPage(){
  const [docs, setDocs] = useState<any[]>([]);
  const [mode, setMode] = useState<Mode>("ask");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [broad, setBroad] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [memoryOn, setMemoryOn] = useState(true);
  const [chatCfg, setChatCfg] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [compareQ, setCompareQ] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [summarizeDoc, setSummarizeDoc] = useState<string | null>(null);
  const [summarizeLoading, setSummarizeLoading] = useState(false);
  const [armedExport, setArmedExport] = useState<"pdf" | "html" | null>("pdf");
  const [lastSummaryDoc, setLastSummaryDoc] = useState<string | null>(null);
  const [summarizeStatus, setSummarizeStatus] = useState<{ stage: string; detail?: string; current?: number; total?: number; since: number } | null>(null);
  const [exportingFmt, setExportingFmt] = useState<"pdf" | "html" | null>(null);
  const [exportNote, setExportNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [matrixIds, setMatrixIds] = useState<string[]>([]);
  const [matrixRows, setMatrixRows] = useState<any[] | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [synthIds, setSynthIds] = useState<string[]>([]);
  const [synthQ, setSynthQ] = useState("");
  const [synthAns, setSynthAns] = useState<string | null>(null);
  const [synthLoading, setSynthLoading] = useState(false);
  const [scopeOpenMobile, setScopeOpenMobile] = useState(false);
  const [compareOpenMobile, setCompareOpenMobile] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hybridMode, setHybridMode] = useState<"off"|"low"|"medium"|"high"|"maximum">("off");
  const { activeConversation, addMessage, removeMessage, updateMessage, truncateAfter, clearActive, clearMemory, memoryCutoff } = useChat();
  const { settings } = useInference();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // streaming state for real-time generation
  const [streaming, setStreaming] = useState<{ answer: string; thinking: string | null; raw: string; sources: any[] | null; retrieved: unknown } | null>(null);
  const [streamStatus, setStreamStatus] = useState<{ stage: string; detail?: string; since: number } | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const streamAccRef = useRef<{ answer: string; thinking: string | null; raw: string; sources: any[] | null; sawThinkingEvent: boolean }>({ answer: "", thinking: null, raw: "", sources: null, sawThinkingEvent: false });

  useEffect(()=>{ api.listDocuments({}).then(r=>setDocs(r.documents)).catch(()=>{}); },[]);
  useEffect(()=>{ api.config().then(r=>setChatCfg(r)).catch(()=>{}); },[]);
  // elapsed-time ticker while a status (retrieving / loading / processing) is shown
  useEffect(()=>{
    if (!streamStatus) return;
    const id = setInterval(()=>setStatusNow(Date.now()), 500);
    return ()=>clearInterval(id);
  },[streamStatus]);
  // memory = this conversation's own earlier messages (after any clear-memory
  // cutoff), sent as context when the Memory toggle is on.
  const memoryMessages = (() => {
    if (!memoryOn || !activeConversation) return [];
    const cutoff = memoryCutoff(activeConversation.id);
    return activeConversation.messages
      .filter(m => m.timestamp > cutoff && (m.role === "user" || m.role === "assistant"))
      .slice(-6)
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
  })();
  // only auto-scroll while the user is near the bottom (they can scroll up mid-generation)
  useEffect(()=>{
    if (autoFollow) chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  },[activeConversation?.messages.length, streaming?.answer, streaming?.thinking, loading, summarizeLoading, compareLoading, autoFollow]);

  const handleMainScroll = () => {
    const el = mainRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom !== autoFollow) setAutoFollow(nearBottom);
  };

  const messages = activeConversation?.messages || [];

  const ask = async()=>{
    if(!q.trim() || loading) return;
    const query = q;
    setQ("");
    await sendAsk(query, { scopeIds: selected, broad, thinking: thinkingMode, hybrid: hybridMode, memory: memoryOn });
  };

  // core ask path, reused by input / regenerate / edit
  const sendAsk = async (
    queryText: string,
    opts: { scopeIds?: string[]; broad?: boolean; thinking?: boolean; hybrid?: string; memory?: boolean },
    flags: { skipUserMessage?: boolean } = {}
  ) => {
    const scope = opts.scopeIds ?? selected;
    const broadVal = opts.broad ?? broad;
    const thinkingVal = opts.thinking ?? thinkingMode;
    const hybridVal = opts.hybrid ?? hybridMode;
    const memoryVal = opts.memory ?? memoryOn;

    if (!flags.skipUserMessage) {
      addMessage({
        id: Date.now().toString(),
        role: "user",
        content: queryText,
        thinkingEnabled: thinkingVal,
        broad: broadVal,
        hybridMode: hybridVal === "off" ? undefined : hybridVal,
        scopeIds: scope,
        timestamp: Date.now(),
        type: "ask",
      });
    }
    setLoading(true);
    setAutoFollow(true);
    setStreaming({ answer: "", thinking: null, raw: "", sources: null, retrieved: null });
    setStreamStatus({ stage: "starting", since: Date.now() });
    streamAccRef.current = { answer: "", thinking: null, raw: "", sources: null, sawThinkingEvent: false };

    const controller = new AbortController();
    abortRef.current = controller;

    let didFallback = false;
    const handleFallback = async () => {
      if (didFallback) return;
      didFallback = true;
      try{
        const r = await api.ask({ query: queryText, document_ids: scope.length? scope : undefined, broad: broadVal, thinking: thinkingVal, use_memory: memoryVal, hybrid_mode: hybridVal, memoryMessages: memoryVal ? memoryMessages : [] });
        addMessage({
          id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
          role:"assistant",
          content: r.answer,
          sources: r.sources,
          thinking: r.thinking || null,
          thinkingEnabled: thinkingVal,
          timestamp: Date.now(),
          type:"ask",
          meta: { retrieved: r.retrieved }
        });
      } catch(e:any){
        addMessage({ id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), role:"assistant", content: "Error: "+e.message, timestamp: Date.now(), type:"ask" });
      } finally{
        setStreaming(null);
        setStreamStatus(null);
        setLoading(false);
        abortRef.current = null;
        setTimeout(()=>inputRef.current?.focus(), 100);
      }
    };

    // stop: finalize whatever streamed so far as a (marked) partial answer.
    // The partial text is KEPT in the chat - nothing is thrown away.
    const finalizeStopped = () => {
      didFallback = true;
      const acc = streamAccRef.current;
      let content: string;
      let thinking: string | null = null;
      if (acc.sawThinkingEvent) {
        content = acc.answer;
        thinking = acc.thinking;
      } else {
        // pre-explicit-events fallback: parse <think> out of the raw text
        const parsed = parseThinking(acc.raw);
        content = parsed.answer;
        thinking = parsed.thinking || null;
      }
      content = content.trim();
      thinking = thinking?.trim() || null;
      if (!content && !thinking) content = "(stopped — nothing generated yet)";
      else if (!content && thinking) content = "(stopped while thinking)";
      addMessage({
        id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
        role: "assistant",
        content,
        thinking,
        sources: acc.sources || undefined,
        thinkingEnabled: thinkingVal,
        stopped: true,
        timestamp: Date.now(),
        type: "ask",
      });
      setStreaming(null);
      setStreamStatus(null);
      setLoading(false);
      abortRef.current = null;
    };

    try{
      await api.askStream(
        { query: queryText, document_ids: scope.length? scope : undefined, broad: broadVal, thinking: thinkingVal, use_memory: memoryVal, hybrid_mode: hybridVal, memoryMessages: memoryVal ? memoryMessages : [] },
        {
          onMeta: (data) => {
            streamAccRef.current.sources = data.sources;
            setStreaming(prev => prev ? { ...prev, sources: data.sources, retrieved: data.retrieved } : { answer: "", thinking: null, raw: "", sources: data.sources, retrieved: data.retrieved });
          },
          onStatus: (stage, detail) => {
            // "generating" means the first token arrived - the status line
            // has done its job, hide it.
            if (stage === "generating") setStreamStatus(null);
            else setStreamStatus(prev => ({ stage, detail, since: prev?.since ?? Date.now() }));
          },
          onThinking: (delta) => {
            streamAccRef.current.sawThinkingEvent = true;
            streamAccRef.current.thinking = (streamAccRef.current.thinking ?? "") + delta;
            setStreaming(prev => {
              if (!prev) return { answer: "", thinking: delta, raw: "", sources: null, retrieved: null };
              return { ...prev, thinking: (prev.thinking ?? "") + delta };
            });
          },
          onToken: (delta) => {
            streamAccRef.current.raw += delta;
            streamAccRef.current.answer += delta;
            setStreaming(prev => {
              if (!prev) return { answer: delta, thinking: null, raw: delta, sources: null, retrieved: null };
              return { ...prev, answer: prev.answer + delta, raw: prev.raw + delta };
            });
          },
          onDone: (data) => {
            didFallback = true;
            addMessage({
              id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
              role:"assistant",
              content: data.answer,
              sources: data.sources,
              thinking: data.thinking || null,
              thinkingEnabled: thinkingVal,
              timestamp: Date.now(),
              type:"ask",
              meta: { retrieved: data.retrieved }
            });
            setStreaming(null);
            setStreamStatus(null);
            setLoading(false);
            abortRef.current = null;
            setTimeout(()=>inputRef.current?.focus(), 100);
          },
          onError: (err) => {
            setStreaming(null);
            setStreamStatus(null);
            handleFallback();
          }
        },
        controller.signal
      );
    } catch(e:any){
      if (e && (e.name === "AbortError" || controller.signal.aborted)) {
        // user pressed stop - keep the partial answer
        finalizeStopped();
      } else {
        await handleFallback();
      }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  // regenerate the answer for a given assistant message (re-runs its user prompt)
  const regenerate = async (assistantMsgId: string) => {
    if (loading) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userMsg = messages[userIdx];
    truncateAfter(userMsg.id);
    await sendAsk(
      userMsg.content,
      {
        scopeIds: userMsg.scopeIds ?? [],
        broad: userMsg.broad ?? false,
        thinking: userMsg.thinkingEnabled ?? false,
        hybrid: userMsg.hybridMode ?? "off",
        memory: memoryOn,
      },
      { skipUserMessage: true }
    );
  };

  const startEdit = (m: ChatMessage) => { setEditingId(m.id); setEditText(m.content); };

  const saveEdit = async (m: ChatMessage) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text) return;
    updateMessage(m.id, { content: text });
    truncateAfter(m.id);
    await sendAsk(
      text,
      {
        scopeIds: m.scopeIds ?? [],
        broad: m.broad ?? false,
        thinking: m.thinkingEnabled ?? false,
        hybrid: m.hybridMode ?? "off",
        memory: memoryOn,
      },
      { skipUserMessage: true }
    );
  };

  const doCompare = async()=>{
    if(compareIds.length<2 || !compareQ.trim() || compareLoading) return;
    const userMsg: ChatMessage = { id: Date.now().toString(), role:"user", content: `[Compare: ${compareIds.map(id=>docs.find(d=>d.id===id)?.original_filename).join(", ")}] ${compareQ}`, timestamp: Date.now(), type:"compare" };
    addMessage(userMsg);
    const query = compareQ;
    setCompareQ("");
    setAutoFollow(true);
    setCompareLoading(true);
    try{
      const r=await api.compare({ query, document_ids: compareIds });
      addMessage({ id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), role:"assistant", content: r.answer, sources: Object.values(r.sources || {}).flat(), timestamp: Date.now(), type:"compare", meta: r });
    } catch(e:any){ addMessage({ id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), role:"assistant", content: "Error: "+e.message, timestamp: Date.now(), type:"compare" }); }
    finally{ setCompareLoading(false); }
  };

  const flashExportNote = (ok: boolean, msg: string) => {
    setExportNote({ ok, msg });
    window.setTimeout(() => setExportNote((cur) => (cur?.msg === msg ? null : cur)), 10000);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // Export buttons double as arm-toggles: pressing one arms that format
  // (button lights up) so the export fires when summarization finishes.
  // If the selected doc was already summarized, it exports immediately.
  const onExportPress = (fmt: "pdf" | "html")=>{
    if(summarizeLoading || exportingFmt) return;
    if (lastSummaryDoc === summarizeDoc && summarizeDoc) {
      doManualExport(fmt);
      return;
    }
    setArmedExport((cur) => (cur === fmt ? null : fmt));
  };

  const doManualExport = async(fmt: "pdf" | "html")=>{
    if(!summarizeDoc || summarizeLoading || exportingFmt) return;
    setExportingFmt(fmt);
    setExportNote(null);
    try{
      if (fmt === "pdf") {
        // PDF exports via a print view (same summary, no second model run).
        await api.summarizeExport(summarizeDoc, fmt);
        flashExportNote(true, "Opened print view — choose Save as PDF ✓");
        return;
      }
      const blob = await api.summarizeExport(summarizeDoc, fmt);
      const filename = `${docs.find(d=>d.id===summarizeDoc)?.original_filename || "summary"}_summary.${fmt}`;
      downloadBlob(blob, filename);
      const kb = Math.max(1, Math.round(blob.size / 1024));
      flashExportNote(true, `Exported ${filename} (${kb} KB) ✓`);
    } catch(e:any){ flashExportNote(false, `Export failed: ${e.message}`); }
    finally{ setExportingFmt(null); }
  };

  const doSummarize = async()=>{
    if(!summarizeDoc || summarizeLoading) return;
    const doc = docs.find(d=>d.id===summarizeDoc);
    const armed = armedExport;
    const userMsg: ChatMessage = { id: Date.now().toString(), role:"user", content: `Summarize: ${doc?.original_filename || summarizeDoc}`, timestamp: Date.now(), type:"summarize" };
    addMessage(userMsg);
    setAutoFollow(true);
    setSummarizeLoading(true);
    setExportNote(null);
    setSummarizeStatus({ stage: "starting", since: Date.now() });
    // shared finish path for stream-done and plain-fallback responses
    const finishSummary = (r: any)=>{
      const text = r.summary + (r.stats ? `\n\n— _${r.stats.method} • ${r.stats.page_count} pages • ${r.stats.chunk_count} chunks_` : "");
      addMessage({ id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), role:"assistant", content: text, timestamp: Date.now(), type:"summarize", meta: r.stats });
      setLastSummaryDoc(summarizeDoc);
      // armed export: fire the same export the manual button would, from
      // this same summary (no second model run).
      if (armed) doManualExport(armed);
    };
    const failSummary = (msg: string)=>{
      addMessage({ id: "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), role:"assistant", content: "Error: "+msg, timestamp: Date.now(), type:"summarize" });
    };
    try{
      let streamed = false;
      try{
        await api.summarizeStream(
          { document_id: summarizeDoc },
          {
            onStatus: (stage, detail) => setSummarizeStatus({ stage, detail, since: Date.now() }),
            onDone: (data) => { streamed = true; setSummarizeStatus(null); finishSummary(data); },
            onError: (err) => { streamed = true; setSummarizeStatus(null); failSummary(err); },
          }
        );
        // stream ended without done/error (e.g. aborted connection) - fall through
        if (!streamed) {
          const r = await api.summarize({ document_id: summarizeDoc });
          setSummarizeStatus(null);
          finishSummary(r);
        }
      } catch{
        const r = await api.summarize({ document_id: summarizeDoc });
        setSummarizeStatus(null);
        finishSummary(r);
      }
    } catch(e:any){ setSummarizeStatus(null); failSummary(e.message); }
    finally{ setSummarizeLoading(false); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); if(mode==="ask") ask(); else if(mode==="compare") doCompare(); else if(mode==="synthesis") doSynthesis(); }
  };

  const doMatrix = async()=>{
    if(matrixIds.length<1 || matrixLoading) return;
    setMatrixLoading(true); setMatrixRows(null);
    try{ const r = await api.matrix(matrixIds); setMatrixRows(r.rows); }
    catch(e:any){ setMatrixRows([]); }
    finally{ setMatrixLoading(false); }
  };

  const doMatrixExport = async(format: string)=>{
    if(!matrixRows?.length) return;
    try{
      if(format === "md"){
        const r: any = await api.matrixExport(matrixRows, format);
        await navigator.clipboard.writeText(r.markdown);
        return;
      }
      if(format === "xlsx"){
        const blob: any = await api.matrixExport(matrixRows, format);
        const url = URL.createObjectURL(blob as Blob);
        const a = document.createElement("a");
        a.href = url; a.download = "literature_matrix.xlsx"; a.click();
        URL.revokeObjectURL(url);
        return;
      }
      const text: any = await api.matrixExport(matrixRows, format);
      const blob = new Blob([text as string], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `literature_matrix.${format}`; a.click();
      URL.revokeObjectURL(url);
    } catch{}
  };

  const doSynthesis = async()=>{
    if(synthIds.length<2 || !synthQ.trim() || synthLoading) return;
    setSynthLoading(true); setSynthAns(null);
    try{ const r = await api.synthesis(synthIds, synthQ); setSynthAns(r.answer); }
    catch(e:any){ setSynthAns("Error: "+e.message); }
    finally{ setSynthLoading(false); }
  };

  // shared pill styles
  const pillOn = "bg-emerald-500/15 border-emerald-600 text-emerald-300 hover:bg-emerald-500/25";
  const pillOff = "bg-[#212121] border-[#2f2f2f] text-[#8e8e8e] hover:text-white";
  const thinkingOn = thinkingMode;

  const streamLegacyParsed = streaming && streaming.thinking === null && streaming.raw.toLowerCase().includes("<think>")
    ? parseThinking(streaming.raw)
    : null;
  const streamThinking = streamLegacyParsed ? streamLegacyParsed.thinking : (streaming?.thinking ?? null);
  const streamAnswer = streamLegacyParsed ? streamLegacyParsed.answer : (streaming?.answer ?? "");

  const STATUS_LABELS: Record<string, string> = {
    starting: "Starting…",
    retrieving: "Searching documents…",
    reranking: "Reranking results…",
    preparing: "Preparing context…",
    processing_prompt: "Processing prompt…",
    classifying: "Classifying document…",
    mapping: "Mapping — extracting facts…",
    reducing: "Reducing — consolidating…",
    synthesizing: "Synthesizing final summary…",
    exporting: "Exporting report…",
    generating: "Generating…",
    working: "Working…",
  };
  const statusElapsed = streamStatus ? Math.max(0, (statusNow - streamStatus.since) / 1000) : 0;

  return (
    <div className="flex h-[calc(100dvh-56px)] lg:h-screen bg-black text-[#ececec] overflow-hidden relative">
      {/* history drawer - always overlays (never pushes) so it can't collide/collapse the chat. Left sidebar is separately collapsible for width. */}
      {historyOpen && (
        <div className="absolute inset-0 z-20 flex">
          <aside className="w-64 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] h-full flex flex-col shadow-2xl">
            <ChatHistoryPanel onNavigate={()=>setHistoryOpen(false)} />
          </aside>
          <button className="flex-1 bg-black/60 backdrop-blur-[1px]" onClick={()=>setHistoryOpen(false)} aria-label="close history" />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col h-full relative z-0 min-h-0">
        {/* header - static (not sticky) so it never covers the first message */}
        <header className="shrink-0 border-b border-[#2f2f2f] bg-black relative z-0">
          <div className="max-w-4xl mx-auto px-4 lg:px-6 py-3">
            <div className="flex items-center gap-2">
              <button
                onClick={()=>setHistoryOpen(!historyOpen)}
                className={`h-9 w-9 grid place-items-center rounded-xl border text-[#ececec] shrink-0 ${historyOpen ? "bg-white text-black border-white" : "bg-[#212121] border-[#2f2f2f] hover:bg-[#2f2f2f]"}`}
                title="Chat history"
              >☰</button>

              <div className="flex gap-1 p-1 bg-[#212121] rounded-xl border border-[#2f2f2f] overflow-x-auto no-scrollbar max-w-full">
                {(["ask","compare","summarize","matrix","synthesis"] as Mode[]).map(m=>(
                  <button key={m} onClick={()=>setMode(m)} className={`px-2.5 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium capitalize transition shrink-0 whitespace-nowrap ${mode===m ? "bg-white text-black" : "text-[#8e8e8e] hover:text-white"}`}>
                    {m}
                  </button>
                ))}
              </div>

              <div className="ml-auto flex items-center gap-2">
                {mode==="ask" && (
                  <>
                    <button onClick={()=>setThinkingMode(!thinkingMode)} className={`hidden sm:flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition ${thinkingOn ? pillOn : pillOff}`} title="Thinking mode: model reasons step-by-step before answering. Toggle on for hypotheses.">
                      <span className={`h-2 w-2 rounded-full ${thinkingOn?"bg-emerald-400":"bg-[#8e8e8e]"}`} /> Thinking
                    </button>
                    <button onClick={()=>setMemoryOn(!memoryOn)} className={`hidden sm:flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border transition ${memoryOn ? pillOn : pillOff}`} title="Conversation memory: follow-up questions remember earlier answers">
                      <span className={`h-2 w-2 rounded-full ${memoryOn?"bg-emerald-400":"bg-[#8e8e8e]"}`} /> Memory
                    </button>
                    <select value={hybridMode} onChange={e=>setHybridMode(e.target.value as any)} className={`hidden sm:block rounded-full px-3 py-1.5 text-xs font-medium border outline-none cursor-pointer transition ${hybridMode!=="off" ? pillOn : pillOff}`} title="Hybrid source: mix the documents with the model's training data. Low = 20/80 (mostly documents), Medium = 50/50, High = 80/20 (mostly training data), Maximum = training data only as primary source">
                      <option value="off" className="bg-[#171717] text-[#ececec]">Hybrid: Off</option>
                      <option value="low" className="bg-[#171717] text-[#ececec]">Hybrid: Low (20/80)</option>
                      <option value="medium" className="bg-[#171717] text-[#ececec]">Hybrid: Medium (50/50)</option>
                      <option value="high" className="bg-[#171717] text-[#ececec]">Hybrid: High (80/20)</option>
                      <option value="maximum" className="bg-[#171717] text-[#ececec]">Hybrid: Maximum</option>
                    </select>
                    <label className="hidden sm:flex items-center gap-2 text-xs bg-[#212121] border border-[#2f2f2f] rounded-full px-3 py-1.5 cursor-pointer">
                      <input type="checkbox" checked={broad} onChange={e=>setBroad(e.target.checked)} className="accent-white" />
                      <span className={broad?"text-white":"text-[#8e8e8e]"}>Broad</span>
                    </label>
                    <button onClick={()=>{ clearActive(); clearMemory(); }} className="text-xs text-[#8e8e8e] hover:text-white px-2 hidden sm:block">Clear chat</button>
                  </>
                )}
              </div>
            </div>

            {/* scope - collapsible on mobile */}
            {mode==="ask" && (
              <div className="mt-3">
                <button
                  onClick={()=>setScopeOpenMobile(!scopeOpenMobile)}
                  className="xl:hidden w-full flex items-center justify-between rounded-xl bg-[#171717] border border-[#2f2f2f] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2 text-[#ececec]">
                    <span className="text-[#8e8e8e]">Scope:</span>
                    <span className="font-medium">{selected.length===0 ? "All docs" : `${selected.length} selected`}</span>
                    {selected.length>0 && <span className="hidden sm:inline text-xs text-[#8e8e8e] truncate max-w-[150px]">— {selected.map(id=>docs.find(d=>d.id===id)?.original_filename).join(", ")}</span>}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {selected.length>0 && <span className="h-2 w-2 rounded-full bg-white" />}
                    <span className="text-[#8e8e8e] text-xs">{scopeOpenMobile ? "Hide ▴" : "Show ▾"}</span>
                  </span>
                </button>

                <div className={`${scopeOpenMobile ? "flex" : "hidden"} xl:flex flex-col gap-2 mt-2 xl:mt-0`}>
                  {/* all docs shown: wrap below xl, scrollable single row with fade on xl+ */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 relative">
                      <div className="flex gap-1.5 items-center flex-wrap xl:flex-nowrap xl:overflow-x-auto no-scrollbar py-1.5">
                        <span className="hidden xl:inline text-xs text-[#8e8e8e] mr-1 shrink-0">Scope:</span>
                        <button onClick={()=>setSelected([])} className={`rounded-full px-3 py-1 text-xs border whitespace-nowrap ${selected.length===0 ? "bg-white text-black border-white" : "bg-[#171717] border-[#2f2f2f] text-[#8e8e8e] hover:text-white"}`}>All docs</button>
                        {docs.map(d=>{
                          const on = selected.includes(d.id);
                          return <button key={d.id} onClick={()=> setSelected(on? selected.filter(x=>x!==d.id) : [...selected, d.id])} className={`rounded-full px-3 py-1 text-xs border whitespace-nowrap ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec] hover:bg-[#212121]"}`}>{d.original_filename}</button>
                        })}
                        {selected.length>0 && <button onClick={()=>setSelected([])} className="rounded-full px-3 py-1 text-xs border border-red-900/50 text-red-400 bg-[#171717] whitespace-nowrap">Clear ({selected.length})</button>}
                      </div>
                      <div className="hidden xl:block pointer-events-none absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-black to-transparent" />
                    </div>
                    <span className="hidden xl:inline text-[10px] text-[#5f5f5f] shrink-0">{docs.length} docs</span>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:hidden">
                    <button onClick={()=>setThinkingMode(!thinkingMode)} className={`flex-1 min-w-[90px] flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-medium border transition ${thinkingOn ? pillOn : pillOff}`}>
                      <span className={`h-2 w-2 rounded-full ${thinkingOn?"bg-emerald-400":"bg-[#8e8e8e]"}`} /> Thinking
                    </button>
                    <button onClick={()=>setMemoryOn(!memoryOn)} className={`flex-1 min-w-[90px] flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs font-medium border transition ${memoryOn ? pillOn : pillOff}`}>
                      <span className={`h-2 w-2 rounded-full ${memoryOn?"bg-emerald-400":"bg-[#8e8e8e]"}`} /> Memory
                    </button>
                    <label className="flex-1 min-w-[90px] flex items-center justify-center gap-2 text-xs bg-[#212121] border border-[#2f2f2f] rounded-full py-1.5">
                      <input type="checkbox" checked={broad} onChange={e=>setBroad(e.target.checked)} /> Broad
                    </label>
                    <select value={hybridMode} onChange={e=>setHybridMode(e.target.value as any)} className={`w-full rounded-full py-1.5 px-3 text-xs font-medium border outline-none cursor-pointer transition ${hybridMode!=="off" ? pillOn : pillOff}`} title="Hybrid source: mix the documents with the model's training data">
                      <option value="off" className="bg-[#171717] text-[#ececec]">Hybrid source: Off (documents only)</option>
                      <option value="low" className="bg-[#171717] text-[#ececec]">Hybrid source: Low (20/80)</option>
                      <option value="medium" className="bg-[#171717] text-[#ececec]">Hybrid source: Medium (50/50)</option>
                      <option value="high" className="bg-[#171717] text-[#ececec]">Hybrid source: High (80/20)</option>
                      <option value="maximum" className="bg-[#171717] text-[#ececec]">Hybrid source: Maximum</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
            {mode==="compare" && (
              <div className="mt-3">
                <button
                  onClick={()=>setCompareOpenMobile(!compareOpenMobile)}
                  className="xl:hidden w-full flex items-center justify-between rounded-xl bg-[#171717] border border-[#2f2f2f] px-3 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2 text-[#ececec]">
                    <span className="text-[#8e8e8e]">Compare:</span>
                    <span className="font-medium">{compareIds.length===0 ? "Select docs" : `${compareIds.length} selected`}</span>
                    {compareIds.length>0 && <span className="hidden sm:inline text-xs text-[#8e8e8e] truncate max-w-[150px]">— {compareIds.map(id=>docs.find(d=>d.id===id)?.original_filename).join(", ")}</span>}
                  </span>
                  <span className="text-[#8e8e8e] text-xs shrink-0">{compareOpenMobile ? "Hide ▴" : "Show ▾"}</span>
                </button>
                <div className={`${compareOpenMobile ? "flex" : "hidden"} xl:flex flex-wrap gap-1.5 mt-2 xl:mt-0`}>
                  {docs.map(d=>{
                    const on = compareIds.includes(d.id);
                    return <button key={d.id} onClick={()=> setCompareIds(on? compareIds.filter(x=>x!==d.id) : [...compareIds, d.id])} className={`rounded-full px-3 py-1 text-xs border ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>{d.original_filename} {on?"✓":""}</button>
                  })}
                </div>
              </div>
            )}
            {mode==="summarize" && (
              <div className="mt-3 flex gap-2 items-center flex-wrap">
                <select value={summarizeDoc ?? ""} onChange={e=>setSummarizeDoc(e.target.value || null)} className="flex-1 min-w-[200px] rounded-xl bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-sm text-white">
                  <option value="">Select a document to summarize</option>
                  {docs.map(d=> <option key={d.id} value={d.id}>{d.original_filename} — {d.title?.slice(0,60) ?? ""}</option>)}
                </select>
                <button onClick={doSummarize} disabled={!summarizeDoc || summarizeLoading} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40">{summarizeLoading ? (armedExport ? `Summarizing + exporting ${armedExport.toUpperCase()}…` : "Summarizing…") : "Summarize"}</button>
                <button onClick={()=>onExportPress("pdf")} disabled={!summarizeDoc || summarizeLoading || exportingFmt!==null} title={armedExport==="pdf" ? "Armed — PDF will export when summarization finishes (press again to disarm)" : "Arm PDF export for when summarization finishes"} className={`rounded-xl border px-4 py-2 text-sm disabled:opacity-40 ${armedExport==="pdf" ? "bg-white text-black border-white font-medium" : "border-[#2f2f2f] bg-[#212121] text-white"}`}>{exportingFmt==="pdf" ? "Exporting…" : `Export PDF${armedExport==="pdf" ? " ✓" : ""}`}</button>
                <button onClick={()=>onExportPress("html")} disabled={!summarizeDoc || summarizeLoading || exportingFmt!==null} title={armedExport==="html" ? "Armed — HTML will export when summarization finishes (press again to disarm)" : "Arm HTML export for when summarization finishes"} className={`rounded-xl border px-4 py-2 text-sm disabled:opacity-40 ${armedExport==="html" ? "bg-white text-black border-white font-medium" : "border-[#2f2f2f] bg-[#212121] text-white"}`}>{exportingFmt==="html" ? "Exporting…" : `Export HTML${armedExport==="html" ? " ✓" : ""}`}</button>
              </div>
            )}
            {exportNote && mode==="summarize" && (
              <div className={`mt-2 text-xs px-3 py-1.5 rounded-xl border ${exportNote.ok ? "text-emerald-400 border-emerald-900 bg-emerald-950/30" : "text-red-400 border-red-900 bg-red-950/30"}`}>{exportNote.msg}</div>
            )}
            {mode==="matrix" && (
              <div className="mt-3 flex gap-2 items-center flex-wrap">
                <span className="text-xs text-[#8e8e8e]">Docs:</span>
                {docs.map(d=>{
                  const on = matrixIds.includes(d.id);
                  return <button key={d.id} onClick={()=> setMatrixIds(on? matrixIds.filter(x=>x!==d.id) : [...matrixIds, d.id])} className={`rounded-full px-3 py-1 text-xs border ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>{d.original_filename}</button>
                })}
                <button onClick={doMatrix} disabled={matrixIds.length<1 || matrixLoading} className="rounded-xl bg-white text-black px-5 py-2 text-sm font-medium disabled:opacity-40 ml-auto">{matrixLoading?"Building…":"Build matrix"}</button>
              </div>
            )}
            {mode==="synthesis" && (
              <div className="mt-3 flex gap-2 items-center flex-wrap">
                <span className="text-xs text-[#8e8e8e]">Docs:</span>
                {docs.map(d=>{
                  const on = synthIds.includes(d.id);
                  return <button key={d.id} onClick={()=> setSynthIds(on? synthIds.filter(x=>x!==d.id) : [...synthIds, d.id])} className={`rounded-full px-3 py-1 text-xs border ${on? "bg-white text-black border-white":"bg-[#171717] border-[#2f2f2f] text-[#ececec]"}`}>{d.original_filename}</button>
                })}
                <span className="text-xs text-[#5f5f5f]">pick ≥2, then ask below</span>
              </div>
            )}

            {/* hybrid source disclaimer */}
            {mode==="ask" && hybridMode!=="off" && (
              <div className="mt-3 rounded-lg bg-amber-950/40 border border-amber-800/60 px-3 py-2 text-[11px] leading-relaxed text-amber-300 flex items-start gap-2">
                <span className="shrink-0">⚠</span>
                <span>
                  Hybrid source is <b>on ({hybridMode})</b>. When the documents don&apos;t contain the answer, the model will draw on its training data —
                  and it <b>may hallucinate</b>. Verify critical claims against the cited sources.
                </span>
              </div>
            )}
          </div>
        </header>

        {/* chat - the only scroll container */}
        <main ref={mainRef} onScroll={handleMainScroll} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {!autoFollow && (
            <button
              onClick={()=>{ setAutoFollow(true); chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }}
              className="absolute bottom-4 right-6 z-10 h-10 w-10 rounded-full bg-white text-black grid place-items-center shadow-xl hover:bg-[#ececec]"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <span className="text-base font-bold">↓</span>
            </button>
          )}
          <div className="max-w-3xl mx-auto w-full px-4 lg:px-0">
            {messages.length===0 && !streaming ? (
              <div className="min-h-[60vh] flex flex-col items-center justify-center text-center py-16">
                <div className="h-12 w-12 rounded-2xl bg-white text-black grid place-items-center text-xl mb-4">✦</div>
                <h2 className="text-2xl font-semibold text-white">{mode==="ask" ? "What do you want to know?" : mode==="compare" ? "Compare documents" : mode==="summarize" ? "Summarize a paper" : mode==="matrix" ? "Build a literature matrix" : "Cross-paper synthesis"}</h2>
                <p className="text-sm text-[#8e8e8e] mt-2 max-w-md">
                  {mode==="ask" ? "Ask any question against your library. Toggle Thinking for hypotheses or unanswerable questions — uses the model's built-in reasoning before answering." : mode==="compare" ? "Select ≥2 documents and ask how they relate. Each is retrieved separately and labeled." : mode==="summarize" ? "Pick a document. It is synthesized with verbatim facts preserved." : mode==="matrix" ? "Select documents and generate a matrix: paper, method, dataset, findings, limitations. Export to CSV, XLSX or Markdown." : "Select ≥2 documents and ask what the literature agrees on, disagrees on, or where the gaps are — answers are attributed per source."}
                </p>
                {mode==="ask" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-6 w-full max-w-xl">
                    {[
                      "What methodology was used in the 2024 papers?",
                      "Summarize the key limitations across all documents",
                      "Hypothesis: why does AI improve grading? (use thinking)",
                      "Compare findings on student-teacher relationship",
                    ].map(ex=>(
                      <button key={ex} onClick={()=>{ setQ(ex); setTimeout(()=>inputRef.current?.focus(), 50); }} className="text-left rounded-xl bg-[#171717] border border-[#2f2f2f] p-3 text-sm hover:bg-[#212121] text-[#ececec]">{ex}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-6 space-y-6">
                {messages.map(m=>(
                  <div key={m.id} className={`flex gap-3 ${m.role==="user" ? "justify-end" : "justify-start"}`}>
                    {m.role==="assistant" && <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center text-xs font-bold shrink-0 mt-1">✦</div>}
                    <div className={`max-w-[85%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed break-words ${m.role==="user" ? "bg-[#212121] border border-[#2f2f2f] text-white" : "bg-transparent text-[#ececec]"}`}>
                      {m.role==="assistant" && m.thinking && (
                        <details className="mb-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden group/thinking">
                          <summary className="px-3 py-2 text-xs font-medium text-[#ab68ff] cursor-pointer select-none flex items-center gap-2 list-none">
                            <span className="h-2 w-2 rounded-full bg-[#ab68ff] animate-pulse" /> Thinking
                            <span className="text-[#5f5f5f] font-normal hidden sm:inline">— model reasoning</span>
                            <span className="ml-auto text-[#5f5f5f] group-open/thinking:rotate-180 transition-transform">▾</span>
                          </summary>
                          <div className="px-3 pb-3 pt-1 text-xs leading-relaxed text-[#b4b4b4] whitespace-pre-wrap font-mono border-t border-[#1a1a1a]">{m.thinking}</div>
                        </details>
                      )}

                      {/* markdown rendering for finished messages */}
                      {m.role==="user" ? (
                        editingId===m.id ? (
                          <div className="space-y-2">
                            <textarea
                              value={editText}
                              onChange={e=>setEditText(e.target.value)}
                              rows={3}
                              autoFocus
                              className="w-full rounded-xl bg-black border border-[#2f2f2f] px-3 py-2 text-sm text-white outline-none resize-none"
                            />
                            <div className="flex gap-2 justify-end">
                              <button onClick={()=>setEditingId(null)} className="rounded-full border border-[#2f2f2f] px-3 py-1 text-xs text-[#8e8e8e] hover:text-white">Cancel</button>
                              <button onClick={()=>saveEdit(m)} className="rounded-full bg-white text-black px-3 py-1 text-xs font-medium">Save & regenerate</button>
                            </div>
                          </div>
                        ) : (
                          <Markdown content={m.content} />
                        )
                      ) : (
                        <Markdown content={m.content} />
                      )}

                      {m.role==="assistant" && m.sources && m.sources.length>0 && (
                        <details className="mt-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden group/sources">
                          <summary className="px-3 py-2 text-xs font-medium text-[#8e8e8e] cursor-pointer select-none flex items-center gap-2 list-none">
                            <span className="text-[#8e8e8e]">▸</span> Sources
                            <span className="bg-[#212121] border border-[#2f2f2f] rounded-full px-1.5 py-0.5 text-[11px] text-[#8e8e8e]">{m.sources.length}</span>
                            <span className="ml-auto text-[#5f5f5f] group-open/sources:rotate-90 transition-transform">▸</span>
                          </summary>
                          <div className="px-3 pb-3 space-y-2 border-t border-[#1a1a1a] pt-3">
                            {m.sources.slice(0,6).map((s:any,i:number)=>(
                              <div key={i} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3">
                                <div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation}</div>
                                <div className="text-sm mt-1 text-[#ececec] leading-relaxed">{s.snippet}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}

                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <div className="text-[11px] text-[#5f5f5f]">
                          {new Date(m.timestamp).toLocaleTimeString()}
                          {m.thinkingEnabled ? " • thinking" : ""}
                          {m.broad ? " • broad" : ""}
                          {m.hybridMode ? ` • hybrid ${m.hybridMode}` : ""}
                          {m.stopped ? " • stopped" : ""}
                        </div>
                        {m.role==="assistant" && m.type==="ask" && !m.stopped && (
                          <>
                            <button onClick={()=>regenerate(m.id)} disabled={loading} className="ml-auto text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717] disabled:opacity-40" title="Regenerate this answer">↻ Regenerate</button>
                            <button onClick={()=>navigator.clipboard.writeText(m.content)} className="text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717]" title="Copy answer">⧉ Copy</button>
                          </>
                        )}
                        {m.role==="user" && m.type==="ask" && editingId!==m.id && (
                          <button onClick={()=>startEdit(m)} className="ml-auto text-[11px] text-[#8e8e8e] hover:text-white border border-[#2f2f2f] rounded-full px-2.5 py-1 bg-[#171717]" title="Edit question — regenerates the answer">✎ Edit</button>
                        )}
                      </div>
                    </div>
                    {m.role==="user" && <div className="h-7 w-7 rounded-full bg-[#2f2f2f] text-white grid place-items-center text-xs shrink-0 mt-1">You</div>}
                  </div>
                ))}

                {/* literature matrix output */}
                {mode==="matrix" && matrixRows && (
                  <div className="py-6 space-y-4">
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={()=>doMatrixExport("csv")} className="rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white">Download CSV</button>
                      <button onClick={()=>doMatrixExport("xlsx")} className="rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white">Download XLSX</button>
                      <button onClick={()=>doMatrixExport("md")} className="rounded-full border border-[#2f2f2f] bg-[#212121] px-3 py-1.5 text-xs text-white">Copy Markdown</button>
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-[#2f2f2f]">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#171717] text-[#8e8e8e] uppercase tracking-wider">
                          <tr>
                            {["Paper","Year","Method","Dataset","Findings","Limitations"].map(h=> <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {matrixRows.map((r:any,i:number)=>(
                            <tr key={i} className="border-t border-[#2f2f2f] align-top">
                              <td className="px-3 py-2 text-white">{r.paper}</td>
                              <td className="px-3 py-2 text-[#b4b4b4]">{r.year ?? ""}</td>
                              <td className="px-3 py-2 text-[#ececec]">{r.method}</td>
                              <td className="px-3 py-2 text-[#ececec]">{r.dataset}</td>
                              <td className="px-3 py-2 text-[#ececec]">{r.findings}</td>
                              <td className="px-3 py-2 text-[#ececec]">{r.limitations}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* cross-paper synthesis output */}
                {mode==="synthesis" && synthAns && (
                  <div className="py-6">
                    <div className="rounded-2xl bg-[#171717] border border-[#2f2f2f] px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-[#ececec]">
                      <Markdown content={synthAns} />
                    </div>
                  </div>
                )}

                {/* streaming assistant bubble */}
                {streaming && (
                  <div className="flex gap-3 justify-start">
                    <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center text-xs font-bold shrink-0 mt-1 animate-pulse">✦</div>
                    <div className="max-w-[85%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words bg-transparent text-[#ececec] border border-[#2f2f2f]/50">
                      {/* live pipeline status: what is happening before tokens arrive */}
                      {streamStatus && !streamAnswer && streamThinking === null && (
                        <div className="mb-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] px-3 py-2 flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-white animate-pulse shrink-0" />
                          <span className="text-xs text-[#b4b4b4]">
                            {STATUS_LABELS[streamStatus.stage] || streamStatus.stage}
                            {streamStatus.detail ? ` — ${streamStatus.detail}` : ""}
                          </span>
                          <span className="ml-auto text-[11px] font-mono text-[#5f5f5f] shrink-0">{statusElapsed.toFixed(1)}s</span>
                        </div>
                      )}
                      {streamStatus && streamStatus.stage === "processing_prompt" && (streamAnswer || streamThinking !== null) && (
                        <div className="mb-2 text-[11px] text-[#5f5f5f] font-mono">prompt processed in {statusElapsed.toFixed(1)}s</div>
                      )}
                      {streamThinking !== null && (
                        <details open className="mb-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden">
                          <summary className="px-3 py-2 text-xs font-medium text-[#ab68ff] cursor-pointer select-none flex items-center gap-2 list-none">
                            <span className="h-2 w-2 rounded-full bg-[#ab68ff] animate-pulse" /> Thinking
                            <span className="text-[#5f5f5f] font-normal hidden sm:inline">— model reasoning</span>
                            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                          </summary>
                          <div className="px-3 pb-3 pt-1 text-xs leading-relaxed text-[#b4b4b4] whitespace-pre-wrap font-mono border-t border-[#1a1a1a]">{streamThinking || "…"}</div>
                        </details>
                      )}
                      {streamAnswer ? (
                        <span>{streamAnswer}<span className="inline-block h-3 w-1.5 bg-white ml-0.5 animate-pulse" /></span>
                      ) : streamThinking === null && !streamStatus ? (
                        <span>{streaming.raw}<span className="inline-block h-3 w-1.5 bg-white ml-0.5 animate-pulse" /></span>
                      ) : streamAnswer ? null : (
                        <span className="text-[#8e8e8e] italic">Thinking…</span>
                      )}
                      {streaming.sources && streaming.sources.length>0 && (
                        <details className="mt-3 rounded-xl bg-[#0a0a0a] border border-[#2f2f2f] overflow-hidden">
                          <summary className="px-3 py-2 text-xs font-medium text-[#8e8e8e] cursor-pointer select-none flex items-center gap-2 list-none">
                            <span>▸</span> Sources <span className="bg-[#212121] border border-[#2f2f2f] rounded-full px-1.5 py-0.5 text-[11px]">{streaming.sources.length}</span>
                          </summary>
                          <div className="px-3 pb-3 space-y-2 border-t border-[#1a1a1a] pt-3">
                            {streaming.sources.slice(0,6).map((s:any,i:number)=>(
                              <div key={i} className="rounded-xl bg-[#171717] border border-[#2f2f2f] p-3">
                                <div className="text-xs font-mono text-[#8e8e8e] break-all">{s.citation}</div>
                                <div className="text-sm mt-1 text-[#ececec] leading-relaxed">{s.snippet}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                )}

                {(loading && !streaming) || compareLoading || summarizeLoading ? (
                  <div className="flex gap-3">
                    <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center text-xs font-bold shrink-0">✦</div>
                    <div className="rounded-2xl bg-[#171717] border border-[#2f2f2f] px-4 py-3">
                      <div className="flex items-center gap-2 text-sm text-[#8e8e8e]">
                        <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                        {mode==="summarize" && summarizeStatus ? (
                          <span>{STATUS_LABELS[summarizeStatus.stage] || summarizeStatus.stage}{summarizeStatus.current != null && summarizeStatus.total != null ? ` — batch ${summarizeStatus.current}/${summarizeStatus.total}` : ""}</span>
                        ) : mode==="summarize" ? "Summarizing…" : thinkingOn ? "Thinking…" : "Searching & synthesizing…"}
                      </div>
                      <div className="mt-2 h-2 w-24 rounded-full thinking-shimmer" />
                    </div>
                  </div>
                ) : null}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>
        </main>

        {/* input - static footer */}
        <footer className="shrink-0 border-t border-[#2f2f2f] bg-black pb-[env(safe-area-inset-bottom)]">
          <div className="max-w-3xl mx-auto px-4 py-4">
            {mode==="ask" && (
              <div className="rounded-2xl bg-[#212121] border border-[#2f2f2f] flex items-end gap-2 p-2 focus-within:border-[#404040]">
                <textarea
                  ref={inputRef}
                  value={q}
                  onChange={e=>setQ(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder={selected.length? `Ask the ${selected.length} selected document(s)… (Shift+Enter newline)` : "Ask the library… (Shift+Enter newline)"}
                  className="flex-1 bg-transparent text-white placeholder:text-[#8e8e8e] text-sm px-3 py-2.5 outline-none resize-none max-h-32"
                  style={{ minHeight: "44px" }}
                />
                {loading && streaming ? (
                  <button onClick={stop} className="h-10 w-10 grid place-items-center rounded-xl bg-white text-black shrink-0 hover:bg-[#ececec]" title="Stop generating">
                    <span className="h-3.5 w-3.5 rounded-[3px] bg-black" />
                  </button>
                ) : (
                  <button onClick={ask} disabled={loading || !q.trim()} className="h-10 w-10 grid place-items-center rounded-xl bg-white text-black disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                    <span className="text-lg">↑</span>
                  </button>
                )}
              </div>
            )}
            {mode==="compare" && (
              <div className="rounded-2xl bg-[#212121] border border-[#2f2f2f] flex items-end gap-2 p-2">
                <textarea value={compareQ} onChange={e=>setCompareQ(e.target.value)} onKeyDown={onKeyDown} rows={1} placeholder={compareIds.length<2 ? "Select ≥2 docs first" : "How do they differ on... (Shift+Enter newline)"} className="flex-1 bg-transparent text-white placeholder:text-[#8e8e8e] text-sm px-3 py-2.5 outline-none resize-none" />
                <button onClick={doCompare} disabled={compareLoading || !compareQ.trim() || compareIds.length<2} className="h-10 w-10 grid place-items-center rounded-xl bg-white text-black disabled:opacity-40">↑</button>
              </div>
            )}
            {mode==="summarize" && (
              <div className="text-xs text-[#8e8e8e] text-center py-2">Select a document above and click Summarize. Single-pass synthesis over the extracted text + verbatim facts.</div>
            )}
            {mode==="matrix" && (
              <div className="text-xs text-[#8e8e8e] text-center py-2">Select documents above and click Build matrix. Each row is extracted by your own model; export as CSV / XLSX / Markdown.</div>
            )}
            {mode==="synthesis" && (
              <div className="rounded-2xl bg-[#212121] border border-[#2f2f2f] flex items-end gap-2 p-2">
                <textarea value={synthQ} onChange={e=>setSynthQ(e.target.value)} onKeyDown={onKeyDown} rows={1} placeholder={synthIds.length<2 ? "Select ≥2 docs first" : "What does the literature agree or disagree on? Where are the gaps? (Shift+Enter newline)"} className="flex-1 bg-transparent text-white placeholder:text-[#8e8e8e] text-sm px-3 py-2.5 outline-none resize-none" />
                <button onClick={doSynthesis} disabled={synthLoading || !synthQ.trim() || synthIds.length<2} className="h-10 w-10 grid place-items-center rounded-xl bg-white text-black disabled:opacity-40">↑</button>
              </div>
            )}
            <div className="text-[11px] text-[#5f5f5f] text-center mt-2 px-2">
              {settings.provider === "ollama" ? `${settings.model} • ${settings.numCtx} ctx` : `${settings.cloudProvider}:${settings.cloudModel}`} • Hybrid FTS+vector • {thinkingOn ? "Thinking on" : "Thinking off"} • {memoryOn ? "Memory on" : "Memory off"} • {hybridMode!=="off" ? `Hybrid source ${hybridMode}` : "Strict grounding"}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
