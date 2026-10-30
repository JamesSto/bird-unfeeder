// Small hand-rolled SVG charts. Colors come from CSS custom properties (see style.css),
// so light/dark mode is handled entirely in CSS.

const SVG = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string | number>;

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string } = {}, parent?: Element): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  parent?.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Tooltip (one shared element; rows are [value, label, color var?])

export type TipRow = { value: string; label: string; color?: string; shape?: "line" | "rect" };

const tip = h("div", { class: "tooltip" });
tip.setAttribute("role", "tooltip");
document.body.appendChild(tip);

export function showTip(x: number, y: number, title: string, rows: TipRow[]) {
  tip.replaceChildren();
  h("div", { class: "tip-title", text: title }, tip);
  for (const r of rows) {
    const row = h("div", { class: "tip-row" }, tip);
    const key = h("span", { class: `key key-${r.shape ?? "line"}` }, row);
    if (r.color) key.style.background = `var(${r.color})`;
    else key.style.visibility = "hidden";
    h("strong", { text: r.value }, row);
    h("span", { class: "tip-label", text: r.label }, row);
  }
  tip.style.display = "block";
  const { width, height } = tip.getBoundingClientRect();
  const left = x + 14 + width > window.innerWidth - 8 ? x - 14 - width : x + 14;
  const top = Math.min(Math.max(8, y - height / 2), window.innerHeight - height - 8);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

export function hideTip() {
  tip.style.display = "none";
}

// ---------------------------------------------------------------------------
// Scales & axes

export interface Frame {
  svg: SVGSVGElement;
  w: number;
  h: number;
  m: { t: number; r: number; b: number; l: number };
  x: (t: number) => number;
  y: (v: number) => number;
  from: number;
  to: number;
  y0: number;
  y1: number;
}

export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function frame(container: HTMLElement, opts: { from: number; to: number; y0: number; y1: number; height?: number; left?: number; yFmt?: (v: number) => string; yTicks?: number[]; xAxis?: boolean }): Frame {
  container.replaceChildren();
  const w = Math.max(280, container.clientWidth);
  const hgt = opts.height ?? 220;
  const m = { t: 10, r: 12, b: opts.xAxis === false ? 6 : 26, l: opts.left ?? 48 };
  const svg = svgEl("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: "chart" }, container);
  const x = (t: number) => m.l + ((t - opts.from) / (opts.to - opts.from)) * (w - m.l - m.r);
  const y = (v: number) => hgt - m.b - ((v - opts.y0) / (opts.y1 - opts.y0 || 1)) * (hgt - m.t - m.b);
  const f: Frame = { svg, w, h: hgt, m, x, y, from: opts.from, to: opts.to, y0: opts.y0, y1: opts.y1 };

  const g = svgEl("g", { class: "axis" }, svg);
  const fmtY = opts.yFmt ?? ((v: number) => String(v));
  for (const v of opts.yTicks ?? niceTicks(opts.y0, opts.y1)) {
    const yy = y(v);
    if (yy < m.t - 1 || yy > hgt - m.b + 1) continue;
    svgEl("line", { x1: m.l, x2: w - m.r, y1: yy, y2: yy, class: "grid" }, g);
    svgEl("text", { x: m.l - 6, y: yy + 4, "text-anchor": "end" }, g).textContent = fmtY(v);
  }
  if (opts.xAxis !== false) timeAxis(f, g);
  return f;
}

function timeAxis(f: Frame, g: SVGGElement) {
  const span = f.to - f.from;
  const steps = [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000];
  const maxTicks = Math.max(2, Math.floor((f.w - f.m.l - f.m.r) / 80));
  const step = steps.find((s) => span / s <= maxTicks) ?? 30 * 86_400_000;
  const tzOffset = new Date().getTimezoneOffset() * 60_000;
  const start = Math.ceil((f.from - tzOffset) / step) * step + tzOffset;
  svgEl("line", { x1: f.m.l, x2: f.w - f.m.r, y1: f.h - f.m.b, y2: f.h - f.m.b, class: "baseline" }, g);
  for (let t = start; t <= f.to; t += step) {
    const d = new Date(t);
    const label = step < 86_400_000
      ? d.getHours() === 0 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "numeric" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    svgEl("text", { x: f.x(t), y: f.h - f.m.b + 17, "text-anchor": "middle" }, g).textContent = label;
  }
}

export function fmtTime(t: number, withDate = true): string {
  return new Date(t).toLocaleString(undefined, withDate ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  const hrs = ms / 3_600_000;
  if (hrs < 48) return `${hrs.toFixed(hrs < 10 ? 1 : 0)} h`;
  return `${(hrs / 24).toFixed(1)} days`;
}

// ---------------------------------------------------------------------------
// Line chart with optional min/max band, reference lines and a crosshair tooltip.

export interface LineSeries {
  name: string;
  color: string; // CSS var name, e.g. "--s1"
  values: Array<number | null>;
}

export interface LineOpts {
  from: number;
  to: number;
  times: number[]; // shared x positions (bucket starts)
  bucketMs: number;
  series: LineSeries[];
  band?: { lo: Array<number | null>; hi: Array<number | null>; color: string; label: string };
  refs?: Array<{ v: number; label: string; color: string }>;
  yFmt: (v: number) => string;
  yPad?: number;
  yMinSpan?: number;
  height?: number;
  endLabels?: boolean;
}

export function lineChart(container: HTMLElement, o: LineOpts) {
  const all: number[] = [];
  for (const s of o.series) for (const v of s.values) if (v !== null) all.push(v);
  if (o.band) for (const v of [...o.band.lo, ...o.band.hi]) if (v !== null) all.push(v);
  for (const r of o.refs ?? []) all.push(r.v);
  if (all.length === 0 || o.times.length === 0) return empty(container, "No data in this range");
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const minSpan = o.yMinSpan ?? 0;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * (o.yPad ?? 0.08);
  const ticks = niceTicks(lo - pad, hi + pad);
  const f = frame(container, { from: o.from, to: o.to, y0: Math.min(ticks[0], lo - pad), y1: Math.max(ticks[ticks.length - 1], hi + pad), yFmt: o.yFmt, yTicks: ticks, height: o.height, left: 52 });
  const mid = (i: number) => o.times[i] + o.bucketMs / 2;
  // Break lines where buckets are missing (device offline).
  const gapAfter = (i: number) => i + 1 < o.times.length && o.times[i + 1] - o.times[i] > o.bucketMs * 1.5;

  for (const r of o.refs ?? []) {
    svgEl("line", { x1: f.m.l, x2: f.w - f.m.r, y1: f.y(r.v), y2: f.y(r.v), class: "ref", stroke: `var(${r.color})` }, f.svg);
    svgEl("text", { x: f.w - f.m.r - 4, y: f.y(r.v) - 5, "text-anchor": "end", class: "ref-label" }, f.svg).textContent = r.label;
  }

  if (o.band) {
    let d = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length) {
        const top = run.map((i) => `${f.x(mid(i))},${f.y(o.band!.hi[i]!)}`);
        const bot = run.map((i) => `${f.x(mid(i))},${f.y(o.band!.lo[i]!)}`).reverse();
        d += `M${top.join("L")}L${bot.join("L")}Z`;
      }
      run = [];
    };
    o.times.forEach((_, i) => {
      if (o.band!.lo[i] === null || o.band!.hi[i] === null) return flush();
      run.push(i);
      if (gapAfter(i)) flush();
    });
    flush();
    svgEl("path", { d, class: "band", fill: `var(${o.band.color})` }, f.svg);
  }

  for (const s of o.series) {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${f.x(mid(i)).toFixed(1)},${f.y(v).toFixed(1)}`;
      pen = !gapAfter(i);
    });
    svgEl("path", { d, class: "line", stroke: `var(${s.color})` }, f.svg);
    if (o.endLabels) {
      const li = s.values.findLastIndex((v) => v !== null);
      if (li >= 0) {
        svgEl("circle", { cx: f.x(mid(li)), cy: f.y(s.values[li]!), r: 4, class: "dot", fill: `var(${s.color})` }, f.svg);
      }
    }
  }

  // Crosshair
  const cross = svgEl("line", { y1: f.m.t, y2: f.h - f.m.b, class: "crosshair", visibility: "hidden" }, f.svg);
  const dots = o.series.map((s) => svgEl("circle", { r: 4, class: "dot", fill: `var(${s.color})`, visibility: "hidden" }, f.svg));
  const hit = svgEl("rect", { x: f.m.l, y: f.m.t, width: f.w - f.m.l - f.m.r, height: f.h - f.m.t - f.m.b, fill: "transparent", tabindex: 0 }, f.svg);
  let focusIdx = o.times.length - 1;
  const show = (i: number, cx: number, cy: number) => {
    const xx = f.x(mid(i));
    cross.setAttribute("x1", String(xx));
    cross.setAttribute("x2", String(xx));
    cross.setAttribute("visibility", "visible");
    const rows: TipRow[] = [];
    o.series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].setAttribute("visibility", v === null ? "hidden" : "visible");
      if (v !== null) {
        dots[k].setAttribute("cx", String(xx));
        dots[k].setAttribute("cy", String(f.y(v)));
      }
      rows.push({ value: v === null ? "–" : o.yFmt(v), label: s.name, color: s.color });
    });
    if (o.band && o.band.lo[i] !== null) rows.push({ value: `${o.yFmt(o.band.lo[i]!)} – ${o.yFmt(o.band.hi[i]!)}`, label: o.band.label });
    const title = o.bucketMs > 60_000 ? `${fmtTime(o.times[i])} – ${fmtTime(o.times[i] + o.bucketMs, false)}` : fmtTime(o.times[i]);
    showTip(cx, cy, title, rows);
  };
  const nearest = (px: number) => {
    let best = 0;
    let bd = Infinity;
    o.times.forEach((_, i) => {
      const d = Math.abs(f.x(mid(i)) - px);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  hit.addEventListener("pointermove", (e) => {
    const r = f.svg.getBoundingClientRect();
    focusIdx = nearest(e.clientX - r.left);
    show(focusIdx, e.clientX, e.clientY);
  });
  const leave = () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    hideTip();
  };
  hit.addEventListener("pointerleave", leave);
  hit.addEventListener("blur", leave);
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    focusIdx = Math.max(0, Math.min(o.times.length - 1, focusIdx + (e.key === "ArrowLeft" ? -1 : 1)));
    const r = f.svg.getBoundingClientRect();
    show(focusIdx, r.left + f.x(mid(focusIdx)), r.top + f.h / 2);
    e.preventDefault();
  });
}

export function empty(container: HTMLElement, text: string) {
  container.replaceChildren();
  h("div", { class: "empty", text }, container);
}

// ---------------------------------------------------------------------------
// Columns (one per bucket) growing from a zero baseline.

export function columns(container: HTMLElement, o: { from: number; to: number; bucketMs: number; times: number[]; values: number[]; color: string; yFmt: (v: number) => string; tipLabel: string; ref?: { v: number; label: string }; tipExtra?: (i: number) => TipRow[]; height?: number }) {
  if (o.times.length === 0) return empty(container, "No data in this range");
  const max = Math.max(...o.values, o.ref?.v ?? 0, 1);
  const ticks = niceTicks(0, max * 1.05);
  const f = frame(container, { from: o.from, to: o.to, y0: 0, y1: ticks[ticks.length - 1], yFmt: o.yFmt, yTicks: ticks, height: o.height ?? 160 });
  const slot = Math.max(1, f.x(o.from + o.bucketMs) - f.x(o.from));
  const bw = Math.max(1, Math.min(24, slot - 2));
  o.times.forEach((t, i) => {
    const v = o.values[i];
    const x0 = f.x(t) + (slot - bw) / 2;
    const y0 = f.y(v);
    const hh = f.y(0) - y0;
    const r = Math.min(4, bw / 2, hh);
    const d = `M${x0},${f.y(0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${f.y(0)}Z`;
    if (hh > 0) svgEl("path", { d, class: "col", fill: `var(${o.color})` }, f.svg);
    const hit = svgEl("rect", { x: f.x(t), y: f.m.t, width: slot, height: f.h - f.m.t - f.m.b, fill: "transparent", class: "hit", tabindex: -1 }, f.svg);
    hit.addEventListener("pointermove", (e) => showTip(e.clientX, e.clientY, `${fmtTime(t)} – ${fmtTime(t + o.bucketMs, false)}`, [{ value: o.yFmt(v), label: o.tipLabel, color: o.color, shape: "rect" }, ...(o.tipExtra?.(i) ?? [])]));
    hit.addEventListener("pointerleave", hideTip);
  });
  if (o.ref) {
    svgEl("line", { x1: f.m.l, x2: f.w - f.m.r, y1: f.y(o.ref.v), y2: f.y(o.ref.v), class: "ref", stroke: "var(--ink-muted)" }, f.svg);
    svgEl("text", { x: f.w - f.m.r - 4, y: f.y(o.ref.v) - 5, "text-anchor": "end", class: "ref-label" }, f.svg).textContent = o.ref.label;
  }
}

// ---------------------------------------------------------------------------
// Horizontal bars for a tally.

export function hbars(container: HTMLElement, rows: Array<{ label: string; n: number; color: string; note?: string }>) {
  container.replaceChildren();
  if (rows.length === 0) return empty(container, "No data in this range");
  const total = rows.reduce((s, r) => s + r.n, 0);
  const max = Math.max(...rows.map((r) => r.n));
  const list = h("div", { class: "hbars" }, container);
  for (const r of rows) {
    const row = h("div", { class: "hbar" }, list);
    const lab = h("div", { class: "hbar-label" }, row);
    h("span", { text: r.label }, lab);
    if (r.note) h("span", { class: "muted", text: ` ${r.note}` }, lab);
    const track = h("div", { class: "hbar-track" }, row);
    const fill = h("div", { class: "hbar-fill" }, track);
    fill.style.width = `${Math.max(0.5, (r.n / max) * 100)}%`;
    fill.style.background = `var(${r.color})`;
    h("div", { class: "hbar-value", text: `${r.n.toLocaleString()} · ${((r.n / total) * 100).toFixed(r.n / total < 0.01 ? 2 : 1)}%` }, row);
  }
}
