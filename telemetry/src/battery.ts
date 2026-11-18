// Battery charge and time-to-empty estimate.
//
// The voltage has a daily cycle (about ±4 mV, likely temperature: highest mid-afternoon,
// lowest around dawn) that is as large as three days of drain. A plain straight-line fit
// therefore changes with the time of day you look at it. This fits a trend plus a 24-hour
// sine wave so the cycle doesn't leak into the slope.
//
// The fit runs on estimated charge % rather than millivolts. The device draws a roughly
// constant current, so charge falls at a steady rate while the voltage drops off a cliff near
// empty. Projecting the voltage in a straight line to the empty point would overestimate the
// days left.

const DAY = 86_400_000;
// Upward steps bigger than this are a battery swap or recharge; the daily cycle moves a few mV per hour.
const SWAP_JUMP_MV = 40;
// A fresh battery's voltage sags quickly at first; leave that out of the trend.
const SETTLE_MS = 6 * 3_600_000;
// Separating the daily cycle from the trend needs a few full days; with two, the
// estimate still swung by ±20% on real data.
export const MIN_FIT_MS = 3 * DAY;
export const MAX_FIT_MS = 30 * DAY;

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

type Pt = { t: number; v: number };

// Least squares for y = a + b*x + c*sin(2πx) + d*cos(2πx), with x in days.
function fitDaily(pts: Pt[], y: (p: Pt) => number) {
  const t0 = pts[0].t;
  const m = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
  for (const p of pts) {
    const x = (p.t - t0) / DAY;
    const r = [1, x, Math.sin(2 * Math.PI * x), Math.cos(2 * Math.PI * x)];
    const yv = y(p);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i][j] += r[i] * r[j];
      m[i][4] += r[i] * yv;
    }
  }
  // Gauss-Jordan elimination; the system is small and well-conditioned with 2+ days of data.
  for (let i = 0; i < 4; i++) {
    const piv = m[i][i];
    if (Math.abs(piv) < 1e-9) return null;
    for (let j = i; j < 5; j++) m[i][j] /= piv;
    for (let k = 0; k < 4; k++) {
      if (k === i) continue;
      const f = m[k][i];
      for (let j = i; j < 5; j++) m[k][j] -= f * m[i][j];
    }
  }
  const [a, b, c, d] = m.map((r) => r[4]);
  return { perDay: b, trendAt: (t: number) => a + (b * (t - t0)) / DAY, dailySwing: Math.hypot(c, d) };
}

export interface BatteryTrend {
  pctNow: number; // trend value, with the daily cycle removed
  pctPerDay: number;
  mvPerDay: number;
  dailySwingMv: number; // amplitude of the daily cycle (±)
  daysLeft: number | null; // null when not draining
  emptyAt: number | null;
  fitFrom: number;
  fitDays: number;
}

// pts: real wakes' battery readings, oldest first, covering at least MAX_FIT_MS when available.
// Returns null until there are MIN_FIT_MS of readings since the last swap; `waitUntil` says when.
export function batteryTrend(pts: Pt[], now: number, emptyMv: number): BatteryTrend | { waitUntil: number } | null {
  if (pts.length === 0) return null;
  let start = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].v - pts[i - 1].v > SWAP_JUMP_MV) start = i;
  const from = Math.max(pts[start].t + SETTLE_MS, now - MAX_FIT_MS);
  const seg = pts.filter((p, i) => i >= start && p.t >= from);
  if (seg.length < 48 || seg[seg.length - 1].t - seg[0].t < MIN_FIT_MS) return { waitUntil: from + MIN_FIT_MS };

  const pct = fitDaily(seg, (p) => batteryPct(p.v));
  const mv = fitDaily(seg, (p) => p.v);
  if (!pct || !mv) return null;
  const pctNow = pct.trendAt(now);
  const left = pctNow - batteryPct(emptyMv);
  const daysLeft = pct.perDay < 0 ? Math.max(0, left / -pct.perDay) : null;
  return {
    pctNow,
    pctPerDay: pct.perDay,
    mvPerDay: mv.perDay,
    dailySwingMv: mv.dailySwing,
    daysLeft,
    emptyAt: daysLeft === null ? null : now + daysLeft * DAY,
    fitFrom: seg[0].t,
    fitDays: (seg[seg.length - 1].t - seg[0].t) / DAY,
  };
}
