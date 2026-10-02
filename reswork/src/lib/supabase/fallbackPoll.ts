// Fallback poller for realtime-driven views (Phase 2).
//
// Realtime drives refresh; this only heals missed events (dropped socket,
// table missing from the publication). It is deliberately slow (60s) and
// hidden-aware: a background tab issues zero queries. Callers reset() it on
// realtime activity/reconnect so a flurry of events never stacks a poll on
// top of event-driven refetches.
export const FALLBACK_POLL_MS = 60_000;

export interface FallbackPoll {
  reset: () => void;
  stop: () => void;
}

export function startFallbackPoll(
  onTick: () => void,
  intervalMs: number = FALLBACK_POLL_MS,
): FallbackPoll {
  const tick = (): void => {
    if (typeof document !== "undefined" && document.hidden) return;
    onTick();
  };
  const arm = (): ReturnType<typeof setInterval> =>
    setInterval(tick, intervalMs); // poll-ok: 60s hidden-aware realtime fallback, reset on activity
  let id = arm();
  return {
    reset: () => {
      clearInterval(id);
      id = arm();
    },
    stop: () => clearInterval(id),
  };
}
