import type { Store, WakeRow } from "./db.ts";
import { RAISE_TIMEOUT_MS } from "./packet.ts";

export const config = {
  // This long without a check-in counts as offline. Kept well above the wake interval so the
  // firmware's sleep period can change without touching the server.
  offlineAfterMs: Number(process.env.OFFLINE_AFTER_MS ?? 60 * 60_000),
  batteryEmptyMv: Number(process.env.BATTERY_EMPTY_MV ?? 3300),
  batteryLowMv: Number(process.env.BATTERY_LOW_MV ?? 3500),
};

export type Level = "critical" | "serious" | "warning";
export interface Alert {
  level: Level;
  title: string;
  detail: string;
}

export type SegmentState = "up" | "down" | "unknown" | "offline";
export interface Segment {
  start: number;
  end: number;
  state: SegmentState;
}

const BUCKETS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000];

export function pickBucket(spanMs: number, target = 240): number {
  return BUCKETS.find((b) => spanMs / b <= target) ?? BUCKETS[BUCKETS.length - 1];
}

// Rough single-cell LiPo resting-voltage curve (mV -> %).
const LIPO: Array<[number, number]> = [
  [4200, 100], [4100, 90], [4000, 80], [3900, 65], [3800, 50], [3700, 30], [3600, 15], [3500, 7], [3400, 3], [3300, 0],
];

export function batteryPct(mv: number): number {
  if (mv >= LIPO[0][0]) return 100;
  for (let i = 1; i < LIPO.length; i++) {
    const [v1, p1] = LIPO[i - 1];
    const [v0, p0] = LIPO[i];
    if (mv >= v0) return p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0);
  }
  return 0;
}

// Least-squares slope in mV/day.
function slopePerDay(pts: Array<{ t: number; v: number }>): number | null {
  if (pts.length < 10 || pts[pts.length - 1].t - pts[0].t < 12 * 3_600_000) return null;
  const n = pts.length;
  const t0 = pts[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 86_400_000;
    sx += x; sy += p.v; sxx += x * x; sxy += x * p.v;
  }
  const d = n * sxx - sx * sx;
  return d === 0 ? null : (n * sxy - sx * sy) / d;
}

function stateOf(up: number | null): SegmentState {
  return up === null ? "unknown" : up ? "up" : "down";
}

export function buildSummary(store: Store, from: number, to: number, now: number) {
  const latest = store.latest() ?? null;
  const end = Math.min(to, now);
  const bucketMs = pickBucket(end - from);
  const online = latest !== null && now - latest.ended_at < config.offlineAfterMs;

  // Mode timeline + coverage. Start from the last wake before the window so the window
  // opens in whatever state the device was already in.
  const before = store.recent(0, from, 1)[0];
  const pts = store.points(from, end);
  if (before) pts.unshift({ t: before.started_at, e: before.ended_at, up: before.weight_up });

  const segments: Segment[] = [];
  const gaps: Array<{ start: number; end: number }> = [];
  const push = (start: number, stop: number, state: SegmentState) => {
    start = Math.max(start, from);
    stop = Math.min(stop, end);
    if (stop <= start) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.state === state && prev.end >= start) prev.end = stop;
    else segments.push({ start, end: stop, state });
    if (state === "offline") gaps.push({ start, end: stop });
  };
  const intervals: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const next = pts[i + 1];
    if (next) {
      const gap = next.t - p.e;
      if (gap > config.offlineAfterMs) {
        push(p.t, p.e, stateOf(p.up));
        push(p.e, next.t, "offline");
      } else {
        push(p.t, next.t, stateOf(p.up));
        intervals.push(next.t - p.t);
      }
    } else {
      push(p.t, online ? end : p.e, stateOf(p.up));
      if (!online) push(p.e, end, "offline");
    }
  }
  intervals.sort((a, b) => a - b);
  const medianIntervalMs = intervals.length ? intervals[Math.floor(intervals.length / 2)] : null;
  const observedFrom = pts.length ? Math.max(from, pts[0].t) : end;
  const observedMs = end - observedFrom;
  const offlineMs = gaps.reduce((s, g) => s + g.end - g.start, 0);

  // When did the current mode start? Walk back to the most recent wake in the other state.
  let modeSince: number | null = null;
  if (latest?.weight_up != null) {
    const other = store.lastWithWeight(latest.weight_up ? 0 : 1);
    modeSince = store.firstAfter(other?.started_at ?? 0)?.started_at ?? null;
  }

  // Battery
  const batt = store.latestWith("battery_mv");
  const trendPts = store.batterySince(now - 3 * 86_400_000);
  const slope = slopePerDay(trendPts);
  const battery = batt
    ? {
        mv: batt.battery_mv!,
        adcMv: batt.battery_adc_mv,
        at: batt.started_at,
        pct: Math.round(batteryPct(batt.battery_mv!)),
        slopeMvPerDay: slope,
        daysLeft: slope !== null && slope < 0 ? Math.max(0, (batt.battery_mv! - config.batteryEmptyMv) / -slope) : null,
        emptyMv: config.batteryEmptyMv,
        lowMv: config.batteryLowMv,
      }
    : null;

  const outcomes = store.tally("outcome", from, end);
  const resets = store.tally("reset_reason", from, end);
  const day = { outcomes: store.tally("outcome", now - 86_400_000, now), resets: store.tally("reset_reason", now - 86_400_000, now) };

  // Alerts, worst first.
  const alerts: Alert[] = [];
  const count = (t: Array<{ k: string; n: number }>, ...keys: string[]) => t.filter((r) => keys.includes(r.k)).reduce((s, r) => s + r.n, 0);
  if (latest?.outcome === "raise_failed") {
    alerts.push({
      level: "critical",
      title: "Motor stalled: device is asleep until reset",
      detail: `The weight didn't reach the limit switch within ${RAISE_TIMEOUT_MS / 1000} s at ${fmt(latest.started_at)}.`,
    });
  }
  if (latest && !online && latest.outcome !== "raise_failed") {
    alerts.push({ level: "serious", title: "Device offline", detail: `Last check-in was ${ago(now - latest.ended_at)} ago (${fmt(latest.ended_at)}).` });
  }
  if (battery && battery.mv < config.batteryLowMv) {
    alerts.push({
      level: battery.mv < config.batteryEmptyMv + 100 ? "critical" : "warning",
      title: "Battery low",
      detail: `${battery.mv} mV (about ${battery.pct}%).` + (battery.daysLeft !== null ? ` Roughly ${battery.daysLeft.toFixed(1)} days to ${config.batteryEmptyMv} mV at the current rate.` : ""),
    });
  }
  const badResets = count(day.resets, "brownout", "crash", "watchdog");
  if (badResets > 0) {
    const parts = day.resets.filter((r) => ["brownout", "crash", "watchdog"].includes(r.k)).map((r) => `${r.n} ${r.k}`);
    alerts.push({ level: "warning", title: "Unexpected resets in the last 24 h", detail: `${parts.join(", ")}.` });
  }
  const dayTotal = day.outcomes.reduce((s, r) => s + r.n, 0);
  const skipped = count(day.outcomes, "clock_failed", "presence_failed", "setup_failed");
  if (dayTotal > 0 && skipped / dayTotal > 0.05) {
    alerts.push({ level: "warning", title: "Wakes skipping the presence check", detail: `${skipped} of ${dayTotal} wakes in the last 24 h skipped the presence check.` });
  }
  const anomalies = count(day.outcomes, "anomaly");
  if (anomalies > 0) {
    alerts.push({ level: "warning", title: "Weight in an unexpected position", detail: `${anomalies} wakes in the last 24 h.` });
  }
  const rank: Record<Level, number> = { critical: 0, serious: 1, warning: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level]);

  return {
    now,
    from,
    to: end,
    bucketMs,
    latest,
    online,
    mode: latest?.weight_up == null ? "unknown" : latest.weight_up ? "up" : "down",
    raiseTimeoutMs: RAISE_TIMEOUT_MS,
    offlineAfterMs: config.offlineAfterMs,
    modeSince,
    alerts,
    battery,
    buckets: store.buckets(from, end, bucketMs),
    checkinsPerHour: store.counts(from, end, 3_600_000),
    segments,
    coverage: {
      wakes: pts.length - (before ? 1 : 0),
      observedMs,
      offlineMs,
      pct: observedMs > 0 ? 1 - offlineMs / observedMs : null,
      gapCount: gaps.length,
      gaps: gaps.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 20),
      medianIntervalMs,
    },
    motor: store.motorRuns(from, end),
    outcomes,
    resets,
    recent: store.recent(from, end, 200),
  };
}

export type Summary = ReturnType<typeof buildSummary>;
export type { WakeRow };

function fmt(t: number) {
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function ago(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
