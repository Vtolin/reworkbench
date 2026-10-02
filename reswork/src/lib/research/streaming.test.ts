import { describe, expect, it } from "vitest";
import { parseThinking } from "./streaming";

describe("parseThinking", () => {
  it("splits a closed think block from the answer", () => {
    expect(parseThinking("<think>hmm, let me reason</think>Final answer")).toEqual({
      thinking: "hmm, let me reason",
      answer: "Final answer",
    });
  });

  it("treats an unclosed think tag as still-thinking with prior text kept", () => {
    expect(parseThinking("Partial <think>reasoning so far")).toEqual({
      thinking: "reasoning so far",
      answer: "Partial",
    });
  });

  it("returns plain text untouched when no tags exist", () => {
    expect(parseThinking("  Just an answer  ")).toEqual({ thinking: null, answer: "Just an answer" });
  });

  it("matches tags case-insensitively and strips every block", () => {
    expect(parseThinking("<THINK>a</THINK>mid<Think>b</Think>end")).toEqual({
      thinking: "a",
      answer: "midend",
    });
  });

  it("yields null thinking for an empty think block", () => {
    expect(parseThinking("<think>   </think>answer")).toEqual({ thinking: null, answer: "answer" });
  });
});
