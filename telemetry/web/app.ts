import { columns, empty, fmtDuration, fmtTime, frame, h, hbars, hideTip, lineChart, showTip, svgEl, type TipRow } from "./charts.ts";

// Mirrors the /api/summary response (src/summary.ts).
interface WakeRow {
  id: number;
  received_at: number;
  started_at: number;
  ended_at: number;
  clock_valid: number;
  awake_ms: number | null;
  outcome: string;
  weight_up: number | null;
  battery_mv: number | null;
  battery_adc_mv: number | null;
  reset_reason: string | null;
  wakeup_cause: string | null;
  wifi_rssi: number | null;
  free_heap: number | null;
  min_free_heap: number | null;
  build: string | null;
  wifi_ms: number | null;
  ntp_ms: number | null;
  raise_ms: number | null;
}
type State = "up" | "down" | "unknown" | "offline";
interface Summary {
  now: number;
  from: number;
  to: number;
  bucketMs: number;
  latest: WakeRow | null;
  online: boolean;
  mode: "up" | "down" | "unknown";
  raiseTimeoutMs: number;
  offlineAfterMs: number;
  modeSince: number | null;
  alerts: Array<{ level: "critical" | "serious" | "warning"; title: string; detail: string }>;
  battery: { mv: number; adcMv: number | null; at: number; pct: number; slopeMvPerDay: number | null; daysLeft: number | null; emptyMv: number; lowMv: number } | null;
  buckets: Array<{ t: number; n: number; battery_avg: number | null; battery_min: number | null; battery_max: number | null; awake_avg: number | null; wifi_avg: number | null; ntp_avg: number | null; rssi_avg: number | null }>;
  checkinsPerHour: Array<{ t: number; n: number }>;
  segments: Array<{ start: number; end: number; state: State }>;
  coverage: { wakes: number; observedMs: number; offlineMs: number; pct: number | null; gapCount: number; gaps: Array<{ start: number; end: number }>; medianIntervalMs: number | null };
  motor: Array<{ id: number; t: number; outcome: string; raise_ms: number | null }>;
  outcomes: Array<{ k: string; n: number }>;
  resets: Array<{ k: string; n: number }>;
  recent: WakeRow[];
}

const RANGES: Record<string, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
// Weight up (limit switch pressed) = someone home; the firmware raises it when anyone is home.
const STATE_LABEL: Record<State, string> = { up: "Home mode (weight up)", down: "Away mode (weight down)", unknown: "Unknown", offline: "Offline" };
const STATE_COLOR: Record<State, string> = { up: "--s1", down: "--s2", unknown: "--ink-muted", offline: "--offline" };
const OUTCOMES: Record<string, { label: string; color: string; note?: string }> = {
  no_change: { label: "No change needed", color: "--ink-muted" },
  raised: { label: "Raised weight", color: "--s1", note: "(arrived home)" },
  lowered: { label: "Lowered weight", color: "--s2", note: "(left)" },
  raise_failed: { label: "Raise failed", color: "--critical", note: "(motor timeout)" },
  clock_failed: { label: "NTP sync failed", color: "--warning" },
  presence_failed: { label: "Clock-state fetch failed", color: "--warning" },
  setup_failed: { label: "Skipped presence check", color: "--warning" },
  anomaly: { label: "Weight out of place", color: "--serious" },
};
const RESETS: Record<string, { label: string; color: string }> = {
  deep_sleep: { label: "Deep-sleep timer", color: "--ink-muted" },
  power_on: { label: "Power on", color: "--s1" },
  reset_pin: { label: "Reset button", color: "--s1" },
  software: { label: "Software reset", color: "--s1" },
  brownout: { label: "Brownout", color: "--serious" },
  crash: { label: "Crash", color: "--critical" },
  watchdog: { label: "Watchdog", color: "--critical" },
};

const $ = (id: string) => document.getElementById(id)!;
let range = RANGES[location.hash.slice(1)] ? location.hash.slice(1) : "7d";
let data: Summary | null = null;
let recentShown = 25;

// ---------------------------------------------------------------------------

async function load() {
  document.body.classList.add("loading");
  try {
    const now = Date.now();
    const res = await fetch(`api/summary?from=${now - RANGES[range]}&to=${now}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = (await res.json()) as Summary;
    $("error").hidden = true;
    render();
  } catch (e) {
    $("error").hidden = false;
    $("error").textContent = `Couldn't load telemetry: ${(e as Error).message}`;
  } finally {
    document.body.classList.remove("loading");
  }
}

function render() {
  if (!data) return;
  const d = data;
  renderHeader(d);
  renderAlerts(d);
  renderTiles(d);
  if (!d.latest) {
    for (const id of ["battery", "timeline", "heatmap", "checkins", "timing", "motor", "outcomes", "resets"]) empty($(id), "No telemetry yet. Waiting for the device to check in.");
    return;
  }
  renderBattery(d);
  renderTimeline(d);
  renderHeatmap(d);
  renderCheckins(d);
  renderTiming(d);
  renderMotor(d);
  hbars($("outcomes"), d.outcomes.map((r) => ({ label: OUTCOMES[r.k]?.label ?? r.k, note: OUTCOMES[r.k]?.note, n: r.n, color: OUTCOMES[r.k]?.color ?? "--ink-muted" })));
  hbars($("resets"), d.resets.map((r) => ({ label: RESETS[r.k]?.label ?? r.k, n: r.n, color: RESETS[r.k]?.color ?? "--ink-muted" })));
  renderRecent(d);
}

function renderHeader(d: Summary) {
  const el = $("last-seen");
  el.replaceChildren();
  if (!d.latest) return void (el.textContent = "No check-ins yet");
  const dot = h("span", { class: `status-dot ${d.online ? "ok" : "bad"}` }, el);
  dot.setAttribute("aria-hidden", "true");
  h("span", { text: `${d.online ? "Online" : "Offline"} · last check-in ${fmtDuration(d.now - d.latest.ended_at)} ago` }, el);
}

function renderAlerts(d: Summary) {
  const el = $("alerts");
  el.replaceChildren();
  const icons = { critical: "⛔", serious: "⚠", warning: "⚠" };
  for (const a of d.alerts) {
    const box = h("div", { class: `alert alert-${a.level}` }, el);
    h("span", { class: "alert-icon", text: icons[a.level] }, box).setAttribute("aria-hidden", "true");
    const body = h("div", {}, box);
    h("strong", { text: a.title }, body);
    h("div", { text: a.detail }, body);
  }
}

function tile(parent: HTMLElement, label: string, value: string, sub: string[], extra?: (el: HTMLElement) => void) {
  const t = h("div", { class: "tile" }, parent);
  h("div", { class: "tile-label", text: label }, t);
  const v = h("div", { class: "tile-value", text: value }, t);
  extra?.(v);
  for (const s of sub) h("div", { class: "tile-sub", text: s }, t);
  return t;
}

function renderTiles(d: Summary) {
  const el = $("tiles");
  el.replaceChildren();
  const span = RANGE_NAMES[range];

  const hero = tile(el, "Current mode", d.mode === "up" ? "Home" : d.mode === "down" ? "Away" : "Unknown", [
    d.mode === "up" ? "Weight up" : d.mode === "down" ? "Weight down" : "No limit-switch reading yet",
    d.modeSince ? `Since ${fmtTime(d.modeSince)} (${fmtDuration(d.now - d.modeSince)})` : "",
  ], (v) => {
    const sw = h("span", { class: "swatch" });
    sw.style.background = `var(${STATE_COLOR[d.mode]})`;
    v.prepend(sw);
  });
  hero.classList.add("tile-hero");

  const b = d.battery;
  tile(el, "Battery", b ? `${b.mv.toLocaleString()} mV` : "–", b ? [
    `≈${b.pct}% (LiPo curve, ADC ${b.adcMv ?? "?"} mV × 2)`,
    b.slopeMvPerDay === null ? "Trend: needs 12 h of data" : `${b.slopeMvPerDay >= 0 ? "+" : "−"}${Math.abs(b.slopeMvPerDay).toFixed(0)} mV/day over 3 days` + (b.daysLeft !== null ? ` · ~${b.daysLeft.toFixed(0)} days to ${b.emptyMv} mV` : ""),
  ] : ["No readings"]);

  const c = d.coverage;
  tile(el, `Uptime, ${span}`, c.pct === null ? "–" : `${(c.pct * 100).toFixed(c.pct > 0.999 ? 2 : 1)}%`, [
    `${c.wakes.toLocaleString()} check-ins` + (c.medianIntervalMs ? `, typically every ${fmtDuration(c.medianIntervalMs)}` : ""),
    c.gapCount ? `${c.gapCount} gap${c.gapCount > 1 ? "s" : ""}, longest ${fmtDuration(c.gaps[0].end - c.gaps[0].start)}` : "No gaps",
  ]);

  const raises = d.motor.filter((m) => m.outcome === "raised");
  const lowers = d.motor.filter((m) => m.outcome === "lowered").length;
  const fails = d.motor.filter((m) => m.outcome === "raise_failed").length;
  const durs = raises.map((m) => m.raise_ms!).filter((x) => x !== null).sort((a, b) => a - b);
  tile(el, `Motor runs, ${span}`, `${raises.length + lowers + fails}`, [
    `${plural(raises.length, "raise")} · ${plural(lowers, "lower")}` + (fails ? ` · ${fails} failed` : ""),
    durs.length ? `Median raise ${(durs[Math.floor(durs.length / 2)] / 1000).toFixed(2)} s (${d.raiseTimeoutMs / 1000} s timeout)` : "No raises",
  ]);

  const awake = d.recent.map((r) => r.awake_ms).filter((x): x is number => x !== null);
  const avgAwake = awake.length ? awake.reduce((s, x) => s + x, 0) / awake.length : null;
  tile(el, "Time awake per wake", avgAwake === null ? "–" : `${(avgAwake / 1000).toFixed(1)} s`, [
    `Last ${awake.length} wakes`,
    d.latest?.build ? `Firmware built ${d.latest.build}` : "",
  ]);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const RANGE_NAMES: Record<string, string> = { "24h": "24 h", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

function renderBattery(d: Summary) {
  const bs = d.buckets;
  const refs = d.battery ? [{ v: d.battery.lowMv, label: `Low (${d.battery.lowMv} mV)`, color: "--warning" }] : [];
  lineChart($("battery"), {
    from: d.from,
    to: d.to,
    times: bs.map((b) => b.t),
    bucketMs: d.bucketMs,
    breakMs: d.offlineAfterMs,
    series: [{ name: "Average", color: "--s1", values: bs.map((b) => b.battery_avg) }],
    band: d.bucketMs > 60_000 ? { lo: bs.map((b) => b.battery_min), hi: bs.map((b) => b.battery_max), color: "--s1", label: "Min – max" } : undefined,
    refs,
    yFmt: (v) => `${Math.round(v).toLocaleString()}`,
    yMinSpan: 100,
    height: 240,
    endLabels: true,
  });
}

function renderTimeline(d: Summary) {
  const el = $("timeline");
  const f = frame(el, { from: d.from, to: d.to, y0: 0, y1: 1, height: 74, yTicks: [], left: 12 });
  const top = f.m.t + 4;
  const hh = f.h - f.m.b - top - 4;
  for (const s of d.segments) {
    const x0 = f.x(s.start);
    const w = Math.max(1, f.x(s.end) - x0 - (f.x(s.end) - x0 > 4 ? 2 : 0));
    const r = svgEl("rect", { x: x0, y: top, width: w, height: hh, rx: Math.min(3, w / 2), class: `seg seg-${s.state}`, fill: `var(${STATE_COLOR[s.state]})`, tabindex: -1 }, f.svg);
    r.addEventListener("pointermove", (e) => showTip(e.clientX, e.clientY, STATE_LABEL[s.state], [
      { value: fmtDuration(s.end - s.start), label: "duration", color: STATE_COLOR[s.state], shape: "rect" },
      { value: fmtTime(s.start), label: "from" },
      { value: fmtTime(s.end), label: "to" },
    ]));
    r.addEventListener("pointerleave", hideTip);
  }
  // Share of observed time per state, for the legend.
  const totals: Record<State, number> = { up: 0, down: 0, unknown: 0, offline: 0 };
  for (const s of d.segments) totals[s.state] += s.end - s.start;
  const all = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  legend($("timeline-legend"), (["up", "down", "offline", "unknown"] as State[]).filter((s) => totals[s] > 0).map((s) => ({ color: STATE_COLOR[s], label: `${STATE_LABEL[s]} ${((totals[s] / all) * 100).toFixed(0)}%`, hatch: s === "offline" })));
}

function legend(el: HTMLElement, items: Array<{ color: string; label: string; line?: boolean; hatch?: boolean }>) {
  el.replaceChildren();
  for (const it of items) {
    const li = h("span", { class: "legend-item" }, el);
    const k = h("span", { class: `key ${it.line ? "key-line" : "key-rect"}${it.hatch ? " key-hatch" : ""}` }, li);
    k.style.background = `var(${it.color})`;
    h("span", { text: it.label }, li);
  }
}

// Days x hours: share of observed time in away mode (weight down).
function renderHeatmap(d: Summary) {
  const el = $("heatmap");
  el.replaceChildren();
  const startDay = new Date(d.from);
  startDay.setHours(0, 0, 0, 0);
  const days: Array<{ t: number; cells: Array<{ away: number; seen: number }> }> = [];
  for (let t = startDay.getTime(); t < d.to; ) {
    const next = new Date(t);
    next.setDate(next.getDate() + 1);
    const cells = Array.from({ length: 24 }, () => ({ away: 0, seen: 0 }));
    days.push({ t, cells });
    t = next.getTime();
  }
  const cellStart = (di: number, hr: number) => {
    const x = new Date(days[di].t);
    x.setHours(hr);
    return x.getTime();
  };
  for (const s of d.segments) {
    if (s.state !== "up" && s.state !== "down") continue;
    // Walk the hours this segment covers.
    let t = s.start;
    while (t < s.end) {
      const dt = new Date(t);
      const hourStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours()).getTime();
      const hourEnd = hourStart + 3_600_000;
      const stop = Math.min(s.end, hourEnd);
      const di = days.findIndex((x, i) => x.t <= t && (i + 1 === days.length || days[i + 1].t > t));
      if (di >= 0) {
        const c = days[di].cells[dt.getHours()];
        c.seen += stop - t;
        if (s.state === "down") c.away += stop - t;
      }
      t = stop;
    }
  }

  const grid = h("div", { class: "heatmap" }, el);
  grid.style.setProperty("--rows", String(days.length));
  h("div", { class: "hm-corner" }, grid);
  for (let hr = 0; hr < 24; hr++) {
    h("div", { class: "hm-hour", text: hr % 3 === 0 ? new Date(2000, 0, 1, hr).toLocaleTimeString(undefined, { hour: "numeric" }) : "" }, grid);
  }
  days.forEach((day, di) => {
    h("div", { class: "hm-day", text: new Date(day.t).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" }) }, grid);
    day.cells.forEach((c, hr) => {
      const cell = h("div", { class: "hm-cell" }, grid);
      if (c.seen < 60_000) {
        cell.classList.add("hm-none");
      } else {
        const p = c.away / c.seen;
        cell.style.background = p < 0.005 ? "var(--hm-zero)" : `color-mix(in oklab, var(--s2) ${Math.round(18 + p * 82)}%, var(--surface))`;
      }
      cell.addEventListener("pointermove", (e) => {
        const t0 = cellStart(di, hr);
        const rows: TipRow[] = c.seen < 60_000
          ? [{ value: "No data", label: "offline or out of range" }]
          : [
              { value: `${Math.round((c.away / c.seen) * 100)}%`, label: "away mode (weight down)", color: "--s2", shape: "rect" },
              { value: fmtDuration(c.seen), label: "observed" },
            ];
        showTip(e.clientX, e.clientY, `${fmtTime(t0)} – ${fmtTime(t0 + 3_600_000, false)}`, rows);
      });
      cell.addEventListener("pointerleave", hideTip);
    });
  });
  const scale = h("div", { class: "hm-scale" }, el);
  h("span", { text: "Home all hour" }, scale);
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const sw = h("span", { class: "hm-swatch" }, scale);
    sw.style.background = p === 0 ? "var(--hm-zero)" : `color-mix(in oklab, var(--s2) ${Math.round(18 + p * 82)}%, var(--surface))`;
  }
  h("span", { text: "Away all hour" }, scale);
  const none = h("span", { class: "hm-swatch hm-none" }, scale);
  none.style.marginLeft = "12px";
  h("span", { text: "No data" }, scale);
}

function renderCheckins(d: Summary) {
  const hours = d.checkinsPerHour;
  columns($("checkins"), {
    from: d.from,
    to: d.to,
    bucketMs: 3_600_000,
    times: hours.map((b) => b.t),
    values: hours.map((b) => b.n),
    color: "--s1",
    yFmt: (v) => v.toLocaleString(),
    tipLabel: "check-ins",
  });
  const gl = $("gaps");
  gl.replaceChildren();
  if (d.coverage.gaps.length === 0) return void h("li", { class: "muted", text: `No gaps longer than ${fmtDuration(d.offlineAfterMs)}.` }, gl);
  for (const g of d.coverage.gaps.slice(0, 6)) {
    const li = h("li", {}, gl);
    h("strong", { text: fmtDuration(g.end - g.start) }, li);
    h("span", { class: "muted", text: ` ${fmtTime(g.start)} → ${fmtTime(g.end)}` }, li);
  }
}

function renderTiming(d: Summary) {
  const bs = d.buckets;
  const s = (v: number | null) => (v === null ? null : v / 1000);
  const series = [
    { name: "Total awake", color: "--s1", values: bs.map((b) => s(b.awake_avg)) },
    { name: "Wi-Fi connect", color: "--s2", values: bs.map((b) => s(b.wifi_avg)) },
    { name: "NTP sync", color: "--s3", values: bs.map((b) => s(b.ntp_avg)) },
  ];
  lineChart($("timing"), { from: d.from, to: d.to, times: bs.map((b) => b.t), bucketMs: d.bucketMs, breakMs: d.offlineAfterMs, series, yFmt: (v) => `${v.toFixed(1)} s`, yMinSpan: 1, endLabels: true, height: 200 });
  legend($("timing-legend"), series.map((x) => ({ color: x.color, label: x.name, line: true })));
}

function renderMotor(d: Summary) {
  const el = $("motor");
  const runs = d.motor.filter((m) => m.outcome !== "lowered" && m.raise_ms !== null);
  if (runs.length === 0) return empty(el, "No weight raises in this range");
  const limit = d.raiseTimeoutMs / 1000;
  const maxS = Math.max(limit + 0.5, ...runs.map((r) => r.raise_ms! / 1000 + 0.2));
  const f = frame(el, { from: d.from, to: d.to, y0: 0, y1: maxS, yFmt: (v) => `${v} s`, height: 200 });
  svgEl("line", { x1: f.m.l, x2: f.w - f.m.r, y1: f.y(limit), y2: f.y(limit), class: "ref", stroke: "var(--critical)" }, f.svg);
  svgEl("text", { x: f.w - f.m.r - 4, y: f.y(limit) - 5, "text-anchor": "end", class: "ref-label" }, f.svg).textContent = `Timeout (${limit} s)`;
  for (const r of runs) {
    const failed = r.outcome === "raise_failed";
    const cx = f.x(r.t);
    const cy = f.y(r.raise_ms! / 1000);
    const g = svgEl("g", { class: "pt", tabindex: -1 }, f.svg);
    if (failed) {
      svgEl("path", { d: `M${cx - 5},${cy - 5}L${cx + 5},${cy + 5}M${cx + 5},${cy - 5}L${cx - 5},${cy + 5}`, class: "x-mark" }, g);
    } else {
      svgEl("circle", { cx, cy, r: 4, class: "dot", fill: "var(--s2)" }, g);
    }
    svgEl("circle", { cx, cy, r: 12, fill: "transparent" }, g);
    g.addEventListener("pointermove", (e) => showTip(e.clientX, e.clientY, fmtTime(r.t), [{ value: `${(r.raise_ms! / 1000).toFixed(2)} s`, label: failed ? "raise FAILED: didn't reach switch" : "to reach the limit switch", color: failed ? "--critical" : "--s2" }]));
    g.addEventListener("pointerleave", hideTip);
  }
}

function renderRecent(d: Summary) {
  const body = $("recent-body");
  body.replaceChildren();
  for (const w of d.recent.slice(0, recentShown)) {
    const tr = h("tr", { class: "wake-row" }, body);
    tr.tabIndex = 0;
    const cell = (text: string, cls?: string) => h("td", { text, class: cls }, tr);
    cell(fmtTime(w.started_at) + (w.clock_valid ? "" : " *"));
    const oc = h("td", {}, tr);
    const k = h("span", { class: "key key-rect" }, oc);
    k.style.background = `var(${OUTCOMES[w.outcome]?.color ?? "--ink-muted"})`;
    h("span", { text: OUTCOMES[w.outcome]?.label ?? w.outcome }, oc);
    cell(w.weight_up === null ? "–" : w.weight_up ? "Up" : "Down");
    cell(w.battery_mv === null ? "–" : `${w.battery_mv.toLocaleString()} mV`, "num");
    cell(w.awake_ms === null ? "–" : `${(w.awake_ms / 1000).toFixed(1)} s`, "num");
    cell(w.wifi_ms === null ? "–" : `${(w.wifi_ms / 1000).toFixed(1)} s`, "num");
    cell(RESETS[w.reset_reason ?? ""]?.label ?? w.reset_reason ?? "–");
    const toggle = () => toggleEvents(tr, w);
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
  }
  const more = $("recent-more") as HTMLButtonElement;
  more.hidden = d.recent.length <= recentShown;
}

async function toggleEvents(tr: HTMLTableRowElement, w: WakeRow) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("events-row")) return void next.remove();
  const row = document.createElement("tr");
  row.className = "events-row";
  tr.after(row);
  const td = h("td", {}, row);
  td.colSpan = 7;
  td.textContent = "Loading…";
  const res = await fetch(`api/wakes/${w.id}/events`);
  const events = (await res.json()) as Array<Record<string, unknown> & { event: string; ts: number; uptime_ms?: number }>;
  td.replaceChildren();
  const list = h("ol", { class: "events" }, td);
  for (const e of events) {
    const li = h("li", {}, list);
    h("code", { class: "ev-time", text: `+${(((e.uptime_ms ?? 0) as number) / 1000).toFixed(2)} s` }, li);
    h("strong", { text: e.event }, li);
    const extras = Object.entries(e).filter(([k, v]) => !["event", "ts", "uptime_ms", "unix_time"].includes(k) && v !== "");
    h("span", { class: "muted", text: " " + extras.map(([k, v]) => `${k}=${v}`).join("  ") }, li);
  }
}

// ---------------------------------------------------------------------------

function setRange(r: string) {
  range = r;
  history.replaceState(null, "", `#${r}`);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#ranges button")) b.setAttribute("aria-pressed", String(b.dataset.range === r));
  recentShown = 25;
  load();
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#ranges button")) b.addEventListener("click", () => setRange(b.dataset.range!));
$("recent-more").addEventListener("click", () => {
  recentShown += 50;
  if (data) renderRecent(data);
});
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 150);
});
setInterval(() => document.visibilityState === "visible" && load(), 60_000);
setRange(range);
