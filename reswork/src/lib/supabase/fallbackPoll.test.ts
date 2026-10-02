import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FALLBACK_POLL_MS, startFallbackPoll } from "./fallbackPoll";

// Idle-cost ledger (Phase 2 acceptance): the fallback is the ONLY timer left
// on directory views, so tick counts here translate directly to idle query
// load. Baseline was 12 ticks/min (5s poll x ~7 queries); see report.

// Vitest runs in node (no DOM): stub the one field the poller reads.
function setHidden(hidden: boolean): void {
  Object.defineProperty(globalThis, "document", {
    value: { hidden },
    configurable: true,
    writable: true,
  });
}

function clearDocumentStub(): void {
  // Node has no document; remove the stub so SSR-fallback paths stay honest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
}

describe("fallbackPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearDocumentStub();
  });

  it("uses a 60s-or-longer interval", () => {
    expect(FALLBACK_POLL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("ticks once per interval while the tab is visible", () => {
    const onTick = vi.fn();
    const poll = startFallbackPoll(onTick);
    try {
      vi.advanceTimersByTime(5 * 60_000);
      expect(onTick).toHaveBeenCalledTimes(5);
    } finally {
      poll.stop();
    }
  });

  it("issues zero ticks while the tab is hidden (idle tab ~0 queries/min)", () => {
    const onTick = vi.fn();
    const poll = startFallbackPoll(onTick);
    try {
      setHidden(true);
      vi.advanceTimersByTime(5 * 60_000);
      expect(onTick).not.toHaveBeenCalled();
      // And resumes when visible again without a catch-up burst.
      setHidden(false);
      vi.advanceTimersByTime(FALLBACK_POLL_MS);
      expect(onTick).toHaveBeenCalledTimes(1);
    } finally {
      poll.stop();
    }
  });

  it("reset() postpones the next tick (no stacking after realtime activity)", () => {
    const onTick = vi.fn();
    const poll = startFallbackPoll(onTick);
    try {
      vi.advanceTimersByTime(FALLBACK_POLL_MS - 1_000);
      poll.reset();
      vi.advanceTimersByTime(FALLBACK_POLL_MS - 1_000);
      expect(onTick).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(onTick).toHaveBeenCalledTimes(1);
    } finally {
      poll.stop();
    }
  });

  it("stop() halts all future ticks (unmount / workspace switch)", () => {
    const onTick = vi.fn();
    const poll = startFallbackPoll(onTick);
    poll.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onTick).not.toHaveBeenCalled();
  });
});
