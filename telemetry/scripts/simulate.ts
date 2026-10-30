// Generates packets shaped exactly like the firmware's (arduino/bird_unfeeder/telemetry.cpp).
//
//   npm run simulate -- backfill 30   write 30 days of history straight into DB_PATH
//   npm run simulate -- live          POST a wake to the running server every 60 s
// SIM_INTERVAL_MS sets the sleep between wakes (default 60000).
//   npm run simulate -- once          POST a single wake
import { Store } from "../src/db.ts";
import { parsePacket, type RawEvent } from "../src/packet.ts";

const [mode = "once", arg] = process.argv.slice(2);
const URL_ = process.env.TELEMETRY_URL ?? `http://localhost:${process.env.PORT ?? 8787}/api/telemetry`;
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS ?? 60_000);
const AUTH = "Basic " + Buffer.from(`${process.env.AUTH_USER ?? "admin"}:${process.env.AUTH_PASSWORD ?? "rogerDodger"}`).toString("base64");

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// Someone is away on weekdays 8:30-17:30 and for a 3-day trip ten days ago.
function someoneHome(t: number, now: number): boolean {
  const d = new Date(t);
  const daysAgo = (now - t) / 86_400_000;
  if (daysAgo > 10 && daysAgo < 13) return false;
  const hr = d.getHours() + d.getMinutes() / 60;
  const weekday = d.getDay() >= 1 && d.getDay() <= 5;
  return !(weekday && hr > 8.5 && hr < 17.5);
}

// Slow drain, swapped for a fresh battery 18 days ago.
function batteryMv(t: number, now: number): number {
  const daysAgo = (now - t) / 86_400_000;
  const since = daysAgo > 18 ? 40 - daysAgo : 18 - daysAgo;
  return 4150 - since * 22 - (since > 15 ? (since - 15) * 15 : 0) + rand(-12, 12);
}

interface Device {
  weightUp: boolean;
  resetReason: string;
}

function wake(start: number, now: number, dev: Device): RawEvent[] {
  const events: RawEvent[] = [];
  let up = rand(30, 60);
  // The RTC keeps time across deep sleep, but not across a power-on reset.
  const rtcValid = dev.resetReason === "deep_sleep";
  let synced = false;
  const add = (event: string, extra: Partial<RawEvent> = {}) => {
    const clock = rtcValid || synced;
    events.push({
      event,
      unix_time: clock ? Math.floor((start + up) / 1000) : Math.floor(up / 1000),
      clock_valid: clock,
      uptime_ms: Math.round(up),
      limit_switch_pressed: dev.weightUp,
      msg: "",
      ...extra,
    });
  };
  const adc = Math.round(batteryMv(start, now) / 2);
  add("WOKE_UP", {
    battery_adc_mv: adc,
    battery_mv_est: adc * 2,
    reset_reason: dev.resetReason,
    wakeup_cause: dev.resetReason === "deep_sleep" ? "timer" : "not_from_sleep",
    wifi_rssi: 0,
    wifi_channel: 0,
    free_heap: 260_000 + Math.round(rand(-2000, 2000)),
    min_free_heap: 250_000,
    build: "Oct 29 2026 02:41:10",
  });
  dev.resetReason = "deep_sleep";
  up += 5;
  add("CONNECTING_TO_WIFI");
  up += Math.random() < 0.03 ? rand(4000, 12000) : rand(900, 2600);
  add("WIFI_CONNECTED");
  up += Math.random() < 0.02 ? rand(3000, 9000) : rand(120, 900);
  synced = true;
  add("CLOCK_SET");
  up += rand(400, 1100);
  // The firmware has no to_string() case for CLOCK_STATE_FETCH_FAILURE, so it arrives as UNKNOWN.
  if (Math.random() < 0.002) {
    add("UNKNOWN", { msg: "get failed" });
    up += 3;
    add("ENTERING_SLEEP");
    return events;
  }
  // Mirrors the firmware: this event always says HOME.
  add("FOUND_CLOCK_STATE_HOME");
  const home = someoneHome(start, now);
  // Someone home: raise the weight. Nobody home: lower it.
  if (!home && dev.weightUp) {
    add("STARTING_LOWER_WEIGHT");
    up += 5000;
    dev.weightUp = false;
    add("FINISHED_LOWER_WEIGHT");
  } else if (home && !dev.weightUp) {
    add("STARTING_RAISE_WEIGHT");
    const sinceSwap = ((now - start) / 86_400_000) % 18;
    up += Math.min(8000, rand(4000, 5000) + sinceSwap * 190);
    if (up - events[events.length - 1].uptime_ms! >= 8000) {
      add("RAISE_WEIGHT_FAILURE");
    } else {
      dev.weightUp = true;
      add("FINISHED_RAISE_WEIGHT");
    }
  }
  up += 3;
  add("ENTERING_SLEEP");
  return events;
}

async function post(events: RawEvent[]) {
  const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Authorization: AUTH }, body: JSON.stringify(events) });
  console.log(res.status, await res.text());
}

if (mode === "backfill") {
  const days = Number(arg ?? 30);
  const now = Date.now();
  const store = new Store(process.env.DB_PATH ?? "data/telemetry.db");
  const dev: Device = { weightUp: false, resetReason: "power_on" };
  let n = 0;
  store.transaction(() => {
    for (let t = now - days * 86_400_000; t < now; ) {
      // Occasional outages: Wi-Fi drops that never reach the server.
      if (Math.random() < 0.0008) {
        t += rand(10, 90) * 60_000;
        continue;
      }
      if (Math.random() < 0.0003) dev.resetReason = "brownout";
      const events = wake(t, now, dev);
      const last = events[events.length - 1];
      const failed = events.some((e) => e.event === "RAISE_WEIGHT_FAILURE");
      store.insert(parsePacket(events, t + last.uptime_ms! + 400));
      n++;
      // A failed raise sleeps until someone power-cycles it.
      if (failed) {
        t += rand(2, 6) * 3_600_000;
        dev.resetReason = "power_on";
      }
      t += last.uptime_ms! + INTERVAL_MS + rand(0, 400);
    }
  });
  store.close();
  console.log(`inserted ${n} wakes over ${days} days`);
} else {
  const dev: Device = { weightUp: false, resetReason: "deep_sleep" };
  await post(wake(Date.now(), Date.now(), dev));
  if (mode === "live") setInterval(() => post(wake(Date.now(), Date.now(), dev)), INTERVAL_MS);
}
