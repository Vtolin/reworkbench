import { describe, expect, it, beforeEach } from "vitest";
import {
  clearTraces,
  exportTrace,
  listTraces,
  newTraceId,
  setTraceSink,
  traceStep,
  withTrace,
} from "./trace";

beforeEach(() => {
  clearTraces();
  setTraceSink(null);
});

describe("newTraceId", () => {
  it("mints unique ids", () => {
    expect(new Set([newTraceId(), newTraceId(), newTraceId()]).size).toBe(3);
  });
});

describe("traceStep", () => {
  it("records durations + counts, newest trace first", () => {
    const a = newTraceId();
    const b = newTraceId();
    traceStep({ traceId: a, step: "retrieve", ms: 12, provider: "ollama", model: "m", counts: { passages: 4 } });
    traceStep({ traceId: b, step: "rerank", ms: 3 });
    const list = listTraces();
    expect(list.map((t) => t.traceId)).toEqual([b, a]);
    expect(list[1]).toMatchObject({ totalMs: 12 });
  });

  it("has no content-shaped fields anywhere (prompts/keys can't leak)", () => {
    traceStep({ traceId: "t", step: "llm", ms: 1, counts: { messages: 2 } });
    const exported = exportTrace("t");
    expect(exported.length).toBe(1);
    expect(Object.keys(exported[0]).sort()).toEqual(["counts", "ms", "step", "traceId"]);
  });

  it("caps memory (ring per trace + across traces)", () => {
    for (let i = 0; i < 25; i++) traceStep({ traceId: `t${i}`, step: "s", ms: 1 });
    expect(listTraces().length).toBeLessThanOrEqual(20);
    const id = newTraceId();
    for (let i = 0; i < 250; i++) traceStep({ traceId: id, step: "s", ms: 1 });
    expect(listTraces().find((t) => t.traceId === id)?.steps.length).toBeLessThanOrEqual(200);
  });

  it("sends nowhere by default; sinks never break operations", () => {
    let calls = 0;
    const uninstall = setTraceSink(() => {
      calls++;
      throw new Error("sink down");
    });
    expect(() => traceStep({ traceId: "t", step: "s", ms: 1 })).not.toThrow();
    expect(calls).toBe(1);
    uninstall();
    traceStep({ traceId: "t", step: "s2", ms: 1 });
    expect(calls).toBe(1);
  });
});

describe("withTrace", () => {
  it("times success and failure (failure keeps a marker, then rethrows)", async () => {
    const id = newTraceId();
    const out = await withTrace(id, "llm", { provider: "openai", model: "gpt", counts: { messages: 3 } }, async () => "ok");
    expect(out).toBe("ok");
    await expect(
      withTrace(id, "llm", { provider: "openai" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const steps = exportTrace(id);
    expect(steps.length).toBe(2);
    expect(steps[1].counts).toMatchObject({ ok: 0 });
    expect(typeof steps[0].ms).toBe("number");
  });
});
