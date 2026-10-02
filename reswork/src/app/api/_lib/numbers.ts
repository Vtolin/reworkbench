// Finite numeric parsing (Phase 8).
//
// Every limit/numeric request parameter goes through parseBoundedInt —
// never raw Number()/parseInt(). Missing (null/undefined) yields the
// missing value; present-but-non-finite ("abc", Infinity) either errors
// (400 at the call site) or falls back, per explicit policy. Finite values
// are floored and clamped. NaN can therefore never reach a query layer.

export type BoundedIntResult = { value: number | undefined } | { error: string };

export function parseBoundedInt(
  raw: unknown,
  opts: {
    min: number;
    max: number;
    name: string;
    /** Value for missing (null/undefined) input — and for invalid input in "fallback" mode. */
    missing: number | undefined;
    /** "error": invalid input is a 400; "fallback": invalid input acts as missing. */
    onInvalid: "error" | "fallback";
  },
): BoundedIntResult {
  if (raw === null || raw === undefined) return { value: opts.missing };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    if (opts.onInvalid === "error") return { error: `${opts.name} must be a number` };
    return { value: opts.missing };
  }
  return { value: Math.min(Math.max(Math.floor(parsed), opts.min), opts.max) };
}
