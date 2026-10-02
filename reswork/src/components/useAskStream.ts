"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { StoredChatMessage } from "@/contexts/ChatContext";
import {
  executeAskFlow,
  type AskFlowBackend,
  type StreamingState,
  type StreamStatusState,
} from "@/lib/research/askFlow";

// Ask-stream orchestration (Phase 6): the sendAsk machine extracted from
// app/research/page.tsx. State and envelope (ids/timestamps) live here;
// the stream/fallback/abort machine lives in lib/research/askFlow and the
// domain engine (lib/wb/ask) is untouched. Tests drive executeAskFlow with
// fake backends (see askFlow.test.ts).

export interface SendAskOpts {
  scopeIds?: string[];
  broad?: boolean;
  thinking?: boolean;
  hybrid?: string;
  memory?: boolean;
  memoryMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

function assistantId(): string {
  return "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

export function useAskStream(deps: {
  addMessage: (m: StoredChatMessage) => void;
  focusInput?: () => void;
  backend?: AskFlowBackend;
}) {
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatusState | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const backend: AskFlowBackend = deps.backend ?? api;
  const focusInput = deps.focusInput ?? (() => {});

  const sendAsk = async (
    queryText: string,
    opts: SendAskOpts,
    flags: { skipUserMessage?: boolean } = {},
  ): Promise<void> => {
    await executeAskFlow(
      backend,
      {
        queryText,
        scopeIds: opts.scopeIds ?? [],
        broad: opts.broad ?? false,
        thinking: opts.thinking ?? false,
        hybrid: opts.hybrid ?? "off",
        memory: opts.memory ?? true,
        memoryMessages: opts.memoryMessages,
        skipUserMessage: flags.skipUserMessage,
      },
      {
        userMessage: (m) =>
          deps.addMessage({
            id: Date.now().toString(),
            role: m.role,
            content: m.content,
            thinkingEnabled: m.thinkingEnabled,
            broad: m.broad,
            hybridMode: m.hybridMode,
            scopeIds: m.scopeIds,
            timestamp: Date.now(),
            type: "ask",
          }),
        assistantMessage: (m) =>
          deps.addMessage({
            id: assistantId(),
            role: m.role,
            content: m.content,
            sources: m.sources,
            thinking: m.thinking,
            thinkingEnabled: m.thinkingEnabled,
            ...(m.stopped ? { stopped: true } : {}),
            timestamp: Date.now(),
            type: "ask",
            ...(m.meta ? { meta: m.meta } : {}),
          }),
        errorMessage: (text) =>
          deps.addMessage({ id: assistantId(), role: "assistant", content: text, timestamp: Date.now(), type: "ask" }),
        streamingChange: setStreaming,
        statusChange: setStreamStatus,
        loadingChange: setLoading,
        focusInput,
        setController: (c) => {
          abortRef.current = c;
        },
      },
    );
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  return { streaming, streamStatus, loading, sendAsk, stop };
}
