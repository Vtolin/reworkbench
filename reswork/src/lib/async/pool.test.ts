import { describe, expect, it } from "vitest";
import { chunkArray, IN_CHUNK_SIZE, mapWithLimit } from "./pool";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("mapWithLimit", () => {
  it("preserves input order under varying delays", async () => {
    const delays = [30, 5, 20, 10];
    const out = await mapWithLimit(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `item-${i}`;
    });
    expect(out).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  it("bounds concurrency while staying parallel", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
      return n;
    });
    expect(maxActive).toBe(2);
  });

  it("returns empty without calling fn for empty input", async () => {
    let calls = 0;
    const out = await mapWithLimit([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("serializes degenerate limits instead of deadlocking or fanning out", async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const order: number[] = [];
      const out = await mapWithLimit([1, 2, 3], limit, async (n, i) => {
        order.push(i);
        await tick();
        return n * 2;
      });
      expect(out).toEqual([2, 4, 6]);
      expect(order).toEqual([0, 1, 2]);
    }
  });

  it("aborts pending items on first error and rethrows it", async () => {
    const started: number[] = [];
    const boom = new Error("boom");
    await expect(
      mapWithLimit([1, 2, 3], 1, async (n, i) => {
        started.push(i);
        await tick();
        if (i === 0) throw boom;
        return n;
      }),
    ).rejects.toBe(boom);
    // Serial: the failure stopped item 1 and 2 from ever starting.
    expect(started).toEqual([0]);
  });

  it("lets in-flight items settle before rethrowing", async () => {
    const started: number[] = [];
    await expect(
      mapWithLimit([1, 2, 3], 2, async (n, i) => {
        started.push(i);
        if (i === 0) {
          await tick();
          throw new Error("first");
        }
        await new Promise((r) => setTimeout(r, 20));
        return n;
      }),
    ).rejects.toThrow("first");
    // Item 1 was already in flight; item 2 never started.
    expect(started).toEqual([0, 1]);
  });
});

describe("chunkArray", () => {
  it("splits into bounded, order-preserving chunks", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 10)).toEqual([]);
    expect(chunkArray([1, 2], 50)).toEqual([[1, 2]]);
  });

  it("defaults to IN_CHUNK_SIZE and serializes degenerate sizes", () => {
    const items = Array.from({ length: IN_CHUNK_SIZE + 1 }, (_, i) => i);
    const chunks = chunkArray(items);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(IN_CHUNK_SIZE);
    expect(chunks[1]).toEqual([IN_CHUNK_SIZE]);
    expect(chunkArray([1, 2, 3], 0).flat()).toEqual([1, 2, 3]);
  });
});
