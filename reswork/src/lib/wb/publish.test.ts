import { describe, expect, it } from "vitest";
import { buildMessageRows } from "./publish";
import type { Conversation } from "@/contexts/ChatContext";

describe("buildMessageRows", () => {
  it("preserves dynamic cloud provider on assistant messages", () => {
    const conv: Conversation = {
      id: "c1",
      title: "Cloud AI Test",
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Hello from user",
          timestamp: 1001,
        },
        {
          id: "m2",
          role: "assistant",
          content: "Answer from OpenAI",
          model: "gpt-4o",
          timestamp: 1002,
          // Provider dynamically attached
          ...({ provider: "openai" } as Record<string, unknown>),
        },
        {
          id: "m3",
          role: "assistant",
          content: "Answer from Claude",
          model: "claude-3-5-sonnet",
          timestamp: 1003,
          metadata_json: { provider: "anthropic", model: "claude-3-5-sonnet" },
        },
        {
          id: "m4",
          role: "assistant",
          content: "Answer from Ollama local",
          model: "llama3",
          timestamp: 1004,
        },
      ],
    };

    const rows = buildMessageRows("chat-123", conv);
    expect(rows).toHaveLength(4);

    // User message has empty metadata
    expect(rows[0].role).toBe("user");
    expect(rows[0].metadata_json).toEqual({});

    // OpenAI provider preserved
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].metadata_json).toEqual({
      provider: "openai",
      model: "gpt-4o",
      sources: [],
      thinking: null,
    });

    // Anthropic provider preserved from metadata_json
    expect(rows[2].role).toBe("assistant");
    expect(rows[2].metadata_json).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      sources: [],
      thinking: null,
    });

    // Default fallback to ollama
    expect(rows[3].role).toBe("assistant");
    expect(rows[3].metadata_json).toEqual({
      provider: "ollama",
      model: "llama3",
      sources: [],
      thinking: null,
    });
  });

  it("filters out whitespace-only or empty messages", () => {
    const conv: Conversation = {
      id: "c2",
      title: "Filter Test",
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        { id: "m1", role: "user", content: "   ", timestamp: 1001 },
        { id: "m2", role: "user", content: "Valid message", timestamp: 1002 },
      ],
    };

    const rows = buildMessageRows("chat-456", conv);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Valid message");
  });
});
