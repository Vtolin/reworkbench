import { describe, expect, it } from "vitest";
import {
  cleanStreamedAnswer,
  executeAskFlow,
  finalizeStoppedMessage,
  type AskFlowBackend,
  type AskFlowEvents,
  type StreamingState,
  type StreamStatusState,
} from "./askFlow";

function recorder() {
  const events: string[] = [];
  const streaming: Array<StreamingState | null> = [];
  const assistant: unknown[] = [];
  let streamState: StreamingState | null = { answer: "", thinking: null, raw: "", sources: null, retrieved: null };
  const ev: AskFlowEvents = {
    userMessage: (m) => {
      events.push(`user:${m.content}`);
    },
    assistantMessage: (m) => {
      events.push(`assistant:${m.content}`);
      assistant.push(m);
    },
    errorMessage: (t) => {
      events.push(`error:${t}`);
    },
    streamingChange: (fn) => {
      streamState = fn(streamState);
      streaming.push(streamState);
    },
    statusChange: (fn: (prev: StreamStatusState | null) => StreamStatusState | null) => {
      events.push("status");
      void fn;
    },
    loadingChange: (l) => {
      events.push(`loading:${l}`);
    },
    focusInput: () => {
      events.push("focus");
    },
    setController: () => {},
  };
  return { events, assistant, streaming, getStream: () => streamState, ev };
}

const INPUT = {
  queryText: "what?",
  scopeIds: ["d1"],
  broad: false,
  thinking: false,
  hybrid: "off",
  memory: true,
  memoryMessages: [{ role: "user" as const, content: "earlier" }],
};

function streamBackend(script: (h: {
  onMeta: (d: { sources: []; retrieved: null }) => void;
  onStatus: (s: string, d?: string) => void;
  onThinking: (d: string) => void;
  onToken: (d: string) => void;
  onDone: (d: { answer: string; sources: []; thinking: string | null; retrieved: null }) => void;
  onError: () => void;
}) => void): AskFlowBackend {
  return {
    askStream: async (body, handlers) => {
      expect(body.query).toBe("what?");
      expect(body.document_ids).toEqual(["d1"]);
      expect(body.memoryMessages).toEqual([{ role: "user", content: "earlier" }]);
      script(handlers as never);
    },
    ask: async () => {
      throw new Error("fallback should not run");
    },
  };
}

describe("executeAskFlow (happy stream)", () => {
  it("streams tokens/meta into state and posts the cleaned answer", async () => {
    const r = recorder();
    await executeAskFlow(
      streamBackend((h) => {
        h.onStatus("retrieving", "fts");
        h.onMeta({ sources: [], retrieved: null });
        h.onToken("Hello ");
        h.onToken("<think>hidden</think>world");
        h.onDone({ answer: "Hello <think>hidden</think>world", sources: [], thinking: null, retrieved: null });
      }),
      INPUT,
      r.ev,
    );
    expect(r.events[0]).toBe("user:what?");
    expect(r.events).toContain("loading:true");
    expect(r.events).toContain("loading:false");
    expect(r.events).toContain("focus");
    const msg = r.assistant[0] as { content: string; thinking: null; stopped?: boolean };
    // Thinking off: <think> stripped from the posted answer.
    expect(msg.content).toBe("Hello world");
    expect(msg.thinking).toBeNull();
    expect(msg.stopped).toBeUndefined();
    expect(r.getStream()).toBeNull();
  });

  it("keeps thinking content when the toggle is on", async () => {
    const r = recorder();
    await executeAskFlow(
      streamBackend((h) => {
        h.onThinking("t1");
        h.onToken("ans");
        h.onDone({ answer: "ans", sources: [], thinking: "t1", retrieved: null });
      }),
      { ...INPUT, thinking: true },
      r.ev,
    );
    const msg = r.assistant[0] as { content: string; thinking: string };
    expect(msg.content).toBe("ans");
    expect(msg.thinking).toBe("t1");
  });

  it("skips the user message when regenerating", async () => {
    const r = recorder();
    await executeAskFlow(
      streamBackend((h) => {
        h.onDone({ answer: "ok", sources: [], thinking: null, retrieved: null });
      }),
      { ...INPUT, skipUserMessage: true },
      r.ev,
    );
    expect(r.events.some((e) => e.startsWith("user:"))).toBe(false);
    expect(r.assistant.length).toBe(1);
  });
});

describe("executeAskFlow (fallback)", () => {
  it("falls back to non-streaming ask on stream error", async () => {
    const r = recorder();
    const backend: AskFlowBackend = {
      askStream: async (_b, h) => {
        h.onToken("partial…");
        h.onError();
      },
      ask: async () => ({ answer: "fallback answer", sources: [], thinking: null, retrieved: { n: 1 } }),
    };
    await executeAskFlow(backend, INPUT, r.ev);
    const msg = r.assistant[0] as { content: string; meta: { retrieved: { n: number } } };
    expect(msg.content).toBe("fallback answer");
    expect(msg.meta).toEqual({ retrieved: { n: 1 } });
  });

  it("posts an error message when the fallback also fails", async () => {
    const r = recorder();
    const backend: AskFlowBackend = {
      askStream: async () => {
        throw new Error("network down");
      },
      ask: async () => {
        throw new Error("still down");
      },
    };
    await executeAskFlow(backend, INPUT, r.ev);
    expect(r.events.some((e) => e === "error:Error: still down")).toBe(true);
  });
});

describe("executeAskFlow (abort)", () => {
  it("finalizes the partial answer as stopped (thinking off strips tags)", async () => {
    const r = recorder();
    let controller: AbortController | null = null;
    const ev: AskFlowEvents = {
      ...r.ev,
      setController: (c) => {
        controller = c;
      },
    };
    const abortErr = () => new DOMException("aborted", "AbortError");
    const backend: AskFlowBackend = {
      askStream: async (_b, h, signal) => {
        h.onToken("half <think>hmm</think>done");
        await new Promise<void>((_, reject) => {
          // Like a real in-flight fetch: suspend first, abort lands later.
          if (signal?.aborted) {
            reject(abortErr());
            return;
          }
          signal?.addEventListener("abort", () => reject(abortErr()), { once: true });
          queueMicrotask(() => controller?.abort());
        });
      },
      ask: async () => {
        throw new Error("must not fall back after stop");
      },
    };
    await executeAskFlow(backend, INPUT, ev);
    const msg = r.assistant[0] as { content: string; stopped: boolean; thinking: null };
    expect(msg.content).toBe("half done");
    expect(msg.stopped).toBe(true);
    expect(msg.thinking).toBeNull();
  });
});

describe("finalizeStoppedMessage", () => {
  it("marks empty stops explicitly", () => {
    const msg = finalizeStoppedMessage(
      { answer: "", thinking: null, raw: "", sources: null, sawThinkingEvent: false },
      false,
    );
    expect(msg.content).toBe("(stopped — nothing generated yet)");
    expect(msg.stopped).toBe(true);
  });

  it("keeps explicit thinking events with the toggle on", () => {
    const msg = finalizeStoppedMessage(
      { answer: "ans", thinking: " t ", raw: "", sources: [{ citation: "c", snippet: "s", document_id: "d", page: 1, section: null }], sawThinkingEvent: true },
      true,
    );
    expect(msg).toMatchObject({ content: "ans", thinking: "t", stopped: true });
  });

  it("reports thinking-only stops", () => {
    const msg = finalizeStoppedMessage(
      { answer: "  ", thinking: "reasoning…", raw: "", sources: null, sawThinkingEvent: true },
      true,
    );
    expect(msg.content).toBe("(stopped while thinking)");
  });
});

describe("cleanStreamedAnswer", () => {
  it("strips think tags only when thinking is off", () => {
    expect(cleanStreamedAnswer("a<think>b</think>c", false)).toBe("ac");
    expect(cleanStreamedAnswer("a<think>b</think>c", true)).toBe("a<think>b</think>c");
  });
});
