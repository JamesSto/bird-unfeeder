// Guesses which wakes were bench testing rather than the device doing its job, so the
// dashboard can hide them. In normal operation every wake is a deep-sleep timer wake roughly
// POLLING_PERIOD_US (15 min) after the previous one. Testing looks different:
//
//   1. A timer wake that comes much sooner than the polling period (test firmware with a
//      short sleep).
//   2. A manual reset (power_on, reset_pin, software, other) that is followed by a fast wake,
//      or by another manual reset within the hour (repeated power cycling).
//
// Faults (brownout, crash, watchdog) are never flagged: hiding a brownout loop would
// hide a dying battery. A single power-on that is followed by normal 15-minute wakes, such as
// a battery swap, is treated as real.

export const WAKE_INTERVAL_MS = Number(process.env.WAKE_INTERVAL_MS ?? 15 * 60_000);
// Wakes started less than this far apart can't come from the real firmware. The wide margin
// leaves room for RTC drift and time spent awake.
const FAST_MS = (WAKE_INTERVAL_MS * 2) / 3;
const RESET_WINDOW_MS = 60 * 60_000;

const FAULTS = new Set(["brownout", "crash", "watchdog"]);
const isManualReset = (r: string | null) => r !== null && r !== "deep_sleep" && !FAULTS.has(r);

export interface ClassifyRow {
  id: number;
  t: number; // started_at
  reset: string | null;
}

// rows must be sorted by t.
export function inferTests(rows: ClassifyRow[]): Set<number> {
  const tests = new Set<number>();
  // nextReset[i]: start of the first manual reset after row i.
  const nextReset: number[] = new Array(rows.length);
  for (let i = rows.length - 1, t = Infinity; i >= 0; i--) {
    nextReset[i] = t;
    if (isManualReset(rows[i].reset)) t = rows[i].t;
  }
  let lastReset = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const w = rows[i];
    if (w.reset !== null && FAULTS.has(w.reset)) continue;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    if (isManualReset(w.reset)) {
      const fastNext = next !== undefined && next.t - w.t < FAST_MS;
      const resetSoon = w.t - lastReset < RESET_WINDOW_MS || nextReset[i] - w.t < RESET_WINDOW_MS;
      if (fastNext || resetSoon) tests.add(w.id);
      lastReset = w.t;
    } else if (prev !== undefined && w.t - prev.t < FAST_MS) {
      tests.add(w.id);
    }
  }
  return tests;
}
