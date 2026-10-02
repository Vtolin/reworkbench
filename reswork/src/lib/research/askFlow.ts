import { toUserMessage } from "@/lib/errors";
import { parseThinking } from "./streaming";
import type { Source } from "../wb/ask/types";

// Ask-stream orchestration (Phase 6): the exact sendAsk machine extracted
// from app/research/page.tsx, UI-free. The hook (components/useAskStream)
// owns React state and wires these events to setState/addMessage; the domain
// streaming engine (lib/wb/ask) is untouched. AIProvider and retrieval enter
// through the injected backend (default: the api facade), so unit tests drive
// the whole stream/fallback/abort matrix with fakes.

export interface StreamingState {
  answer: string;
  thinking: string | null;
  raw: string;
  sources: Source[] | null;
  retrieved: unknown;
}

export interface StreamStatusState {
  stage: string;
  detail?: string;
  since: number;
}

export interface AskFlowInput {
  queryText: string;
  scopeIds: string[];
  broad: boolean;
  thinking: boolean;
  hybrid: string;
  memory: boolean;
  memoryMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  skipUserMessage?: boolean;
}

export interface AskFlowUserMessage {
  role: "user";
  content: string;
  thinkingEnabled: boolean;
  broad: boolean;
  hybridMode: string | undefined;
  scopeIds: string[];
}

export interface AskFlowAssistantMessage {
  role: "assistant";
  content: string;
  sources?: Source[];
  thinking: string | null;
  thinkingEnabled: boolean;
  stopped?: boolean;
  meta?: { retrieved: unknown };
}

export interface AskFlowBackend {
  askStream: (
    body: {
      query: string;
      document_ids?: string[];
      broad: boolean;
      thinking: boolean;
      use_memory: boolean;
      hybrid_mode: string;
      memoryMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    },
    handlers: {
      onMeta: (data: { sources: Source[]; retrieved: unknown }) => void;
      onStatus: (stage: string, detail?: string) => void;
      onThinking: (delta: string) => void;
      onToken: (delta: string) => void;
      onDone: (data: { answer: string; sources: Source[]; thinking: string | null; retrieved: unknown }) => void;
      onError: () => void;
    },
    signal?: AbortSignal,
  ) => Promise<unknown>;
  ask: (body: {
    query: string;
    document_ids?: string[];
    broad: boolean;
    thinking: boolean;
    use_memory: boolean;
    hybrid_mode: string;
    memoryMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  }) => Promise<{ answer: string; sources: Source[]; thinking: string | null; retrieved: unknown }>;
}

export interface AskFlowEvents {
  userMessage: (msg: AskFlowUserMessage) => void;
  assistantMessage: (msg: AskFlowAssistantMessage) => void;
  errorMessage: (text: string) => void;
  streamingChange: (fn: (prev: StreamingState | null) => StreamingState | null) => void;
  statusChange: (fn: (prev: StreamStatusState | null) => StreamStatusState | null) => void;
  loadingChange: (loading: boolean) => void;
  focusInput: () => void;
  setController: (c: AbortController | null) => void;
}

interface Accumulator {
  answer: string;
  thinking: string | null;
  raw: string;
  sources: Source[] | null;
  sawThinkingEvent: boolean;
}

/** Strip-or-parse thinking per the toggle (verbatim page rules). Pure. */
export function cleanStreamedAnswer(answer: string, thinking: boolean): string {
  return thinking ? answer : answer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Stop finalization (verbatim page rules): keep whatever streamed so far as
 * a marked partial answer — nothing is thrown away.
 */
export function finalizeStoppedMessage(acc: Accumulator, thinking: boolean): AskFlowAssistantMessage {
  let content: string;
  let answerThinking: string | null = null;
  if (acc.sawThinkingEvent) {
    content = acc.answer;
    answerThinking = acc.thinking;
  } else {
    // Pre-explicit-events fallback: parse <think> out of the raw text.
    // Gated on the toggle: with thinking off, strip silently instead of
    // opening a Thinking box (reasoning models emit tags spontaneously).
    const parsed = parseThinking(acc.raw);
    if (thinking) {
      content = parsed.answer;
      answerThinking = parsed.thinking || null;
    } else {
      content = acc.raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      answerThinking = null;
    }
  }
  content = content.trim();
  answerThinking = answerThinking?.trim() || null;
  if (!content && !answerThinking) content = "(stopped — nothing generated yet)";
  else if (!content && answerThinking) content = "(stopped while thinking)";
  return {
    role: "assistant",
    content,
    thinking: answerThinking,
    sources: acc.sources || undefined,
    thinkingEnabled: thinking,
    stopped: true,
  };
}

export async function executeAskFlow(
  backend: AskFlowBackend,
  input: AskFlowInput,
  events: AskFlowEvents,
): Promise<void> {
  const { scopeIds: scope, broad, thinking, hybrid, memory, memoryMessages } = input;

  if (!input.skipUserMessage) {
    events.userMessage({
      role: "user",
      content: input.queryText,
      thinkingEnabled: input.thinking,
      broad: input.broad,
      hybridMode: input.hybrid === "off" ? undefined : input.hybrid,
      scopeIds: input.scopeIds,
    });
  }
  events.loadingChange(true);
  events.streamingChange(() => ({ answer: "", thinking: null, raw: "", sources: null, retrieved: null }));
  events.statusChange(() => ({ stage: "starting", since: Date.now() }));
  const acc: Accumulator = { answer: "", thinking: null, raw: "", sources: null, sawThinkingEvent: false };

  const controller = new AbortController();
  events.setController(controller);

  let didFallback = false;
  const body = {
    query: input.queryText,
    document_ids: scope.length ? scope : undefined,
    broad,
    thinking,
    use_memory: memory,
    hybrid_mode: hybrid,
    memoryMessages: memory ? memoryMessages : [],
  };
  const handleFallback = async () => {
    if (didFallback) return;
    didFallback = true;
    try {
      const r = await backend.ask(body);
      events.assistantMessage({
        role: "assistant",
        content: r.answer,
        sources: r.sources,
        thinking: r.thinking || null,
        thinkingEnabled: thinking,
        meta: { retrieved: r.retrieved },
      });
    } catch (e) {
      events.errorMessage("Error: " + toUserMessage(e));
    } finally {
      events.streamingChange(() => null);
      events.statusChange(() => null);
      events.loadingChange(false);
      events.setController(null);
      events.focusInput();
    }
  };

  // Stop: finalize whatever streamed so far as a (marked) partial answer.
  // The partial text is KEPT in the chat - nothing is thrown away.
  const finalizeStopped = () => {
    didFallback = true;
    events.assistantMessage(finalizeStoppedMessage(acc, thinking));
    events.streamingChange(() => null);
    events.statusChange(() => null);
    events.loadingChange(false);
    events.setController(null);
  };

  try {
    await backend.askStream(body, {
      onMeta: (data) => {
        acc.sources = data.sources;
        events.streamingChange((prev) =>
          prev
            ? { ...prev, sources: data.sources, retrieved: data.retrieved }
            : { answer: "", thinking: null, raw: "", sources: data.sources, retrieved: data.retrieved },
        );
      },
      onStatus: (stage, detail) => {
        // "generating" means the first token arrived - the status line
        // has done its job, hide it.
        if (stage === "generating") events.statusChange(() => null);
        else events.statusChange((prev) => ({ stage, detail, since: prev?.since ?? Date.now() }));
      },
      onThinking: (delta) => {
        if (!thinking) return;
        acc.sawThinkingEvent = true;
        acc.thinking = (acc.thinking ?? "") + delta;
        events.streamingChange((prev) => {
          if (!prev) return { answer: "", thinking: delta, raw: "", sources: null, retrieved: null };
          return { ...prev, thinking: (prev.thinking ?? "") + delta };
        });
      },
      onToken: (delta) => {
        acc.raw += delta;
        acc.answer += delta;
        events.streamingChange((prev) => {
          if (!prev) return { answer: delta, thinking: null, raw: delta, sources: null, retrieved: null };
          return { ...prev, answer: prev.answer + delta, raw: prev.raw + delta };
        });
      },
      onDone: (data) => {
        didFallback = true;
        events.assistantMessage({
          role: "assistant",
          content: cleanStreamedAnswer(data.answer, thinking),
          sources: data.sources,
          thinking: thinking ? data.thinking || null : null,
          thinkingEnabled: thinking,
          meta: { retrieved: data.retrieved },
        });
        events.streamingChange(() => null);
        events.statusChange(() => null);
        events.loadingChange(false);
        events.setController(null);
        events.focusInput();
      },
      onError: () => {
        events.streamingChange(() => null);
        events.statusChange(() => null);
        void handleFallback();
      },
    }, controller.signal);
  } catch (e) {
    if (e && ((e as { name?: string }).name === "AbortError" || controller.signal.aborted)) {
      // User pressed stop - keep the partial answer.
      finalizeStopped();
    } else {
      await handleFallback();
    }
  }
}
