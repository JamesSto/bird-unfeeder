// Parses the payload the bird unfeeder POSTs at the end of every wake cycle
// (see arduino/bird_unfeeder/telemetry.cpp) and derives one summary row per wake.
//
// The payload is a JSON array of events, in the order they happened:
//   [{ "event": "WOKE_UP", "unix_time": 1761700000, "clock_valid": true,
//      "uptime_ms": 12, "limit_switch_pressed": false, "battery_adc_mv": 1950, ... }, ...]

export const EVENT_NAMES = [
  "WOKE_UP",
  "CONNECTING_TO_WIFI",
  "CLOCK_SET_FAILED",
  "CLOCK_SET",
  "WIFI_CONNECTED",
  "WIFI_CONNECTION_FAILED",
  "FOUND_CLOCK_STATE_HOME",
  "FOUND_CLOCK_STATE_AWAY",
  "WEIGHT_NOT_AT_TOP_WHEN_LOWERING",
  "WEIGHT_ALREADY_AT_TOP_WHEN_RAISING",
  "STARTING_LOWER_WEIGHT",
  "STARTING_RAISE_WEIGHT",
  "FINISHED_LOWER_WEIGHT",
  "FINISHED_RAISE_WEIGHT",
  "RAISE_WEIGHT_FAILURE",
  "ENTERING_SLEEP",
] as const;

export interface RawEvent {
  event: string;
  unix_time?: number;
  clock_valid?: boolean;
  uptime_ms?: number;
  limit_switch_pressed?: boolean;
  // Only on WOKE_UP
  battery_adc_mv?: number;
  battery_mv_est?: number;
  reset_reason?: string;
  wakeup_cause?: string;
  wifi_rssi?: number;
  wifi_channel?: number;
  free_heap?: number;
  min_free_heap?: number;
  build?: string;
  [key: string]: unknown;
}

// What a wake cycle ended up doing.
export type Outcome =
  | "raised" // weight raised to the limit switch (nobody home)
  | "lowered" // weight lowered (someone home)
  | "no_change" // checked presence, weight was already where it should be
  | "raise_failed" // motor ran 3s without hitting the switch; device sleeps until manually reset
  | "clock_failed" // NTP sync timed out, presence never checked
  | "setup_failed" // got through Wi-Fi/NTP but never checked presence
  | "anomaly"; // a "weight in the wrong place" guard fired

export interface Wake {
  receivedAt: number;
  startedAt: number;
  endedAt: number;
  clockValid: boolean;
  awakeMs: number | null;
  outcome: Outcome;
  // Weight position when the device went back to sleep. Up (switch pressed) means away mode.
  weightUp: boolean | null;
  batteryMv: number | null;
  batteryAdcMv: number | null;
  resetReason: string | null;
  wakeupCause: string | null;
  wifiRssi: number | null;
  freeHeap: number | null;
  minFreeHeap: number | null;
  build: string | null;
  wifiMs: number | null;
  ntpMs: number | null;
  raiseMs: number | null;
  events: Array<RawEvent & { ts: number }>;
}

export class PacketError extends Error {}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parsePacket(body: unknown, receivedAt: number): Wake {
  if (!Array.isArray(body) || body.length === 0) {
    throw new PacketError("expected a non-empty JSON array of events");
  }
  const events = body.map((e, i) => {
    if (typeof e !== "object" || e === null || typeof (e as RawEvent).event !== "string") {
      throw new PacketError(`event ${i} is missing an "event" string`);
    }
    return e as RawEvent;
  });

  const ts = timestamper(events, receivedAt);
  const stamped = events.map((e) => ({ ...e, ts: ts(e) }));
  const find = (name: string) => stamped.find((e) => e.event === name);
  const has = (name: string) => find(name) !== undefined;
  const between = (a: string, b: string) => {
    const ea = find(a);
    const eb = find(b);
    const ua = num(ea?.uptime_ms);
    const ub = num(eb?.uptime_ms);
    return ua !== null && ub !== null ? ub - ua : null;
  };

  // FOUND_CLOCK_STATE_* can't be trusted for presence (the firmware tests the function
  // pointer `anyone_home` rather than its result, so it always reports HOME), so the
  // outcome is derived from what the motor did instead.
  let outcome: Outcome;
  if (has("RAISE_WEIGHT_FAILURE")) outcome = "raise_failed";
  else if (has("FINISHED_RAISE_WEIGHT")) outcome = "raised";
  else if (has("FINISHED_LOWER_WEIGHT")) outcome = "lowered";
  else if (has("WEIGHT_NOT_AT_TOP_WHEN_LOWERING") || has("WEIGHT_ALREADY_AT_TOP_WHEN_RAISING")) outcome = "anomaly";
  else if (has("CLOCK_SET_FAILED")) outcome = "clock_failed";
  else if (has("FOUND_CLOCK_STATE_HOME") || has("FOUND_CLOCK_STATE_AWAY")) outcome = "no_change";
  else outcome = "setup_failed";

  const first = stamped[0];
  const last = stamped[stamped.length - 1];
  const woke = find("WOKE_UP");
  const lastSwitch = [...stamped].reverse().find((e) => typeof e.limit_switch_pressed === "boolean");

  return {
    receivedAt,
    startedAt: first.ts,
    endedAt: last.ts,
    clockValid: stamped.some((e) => e.clock_valid === true),
    awakeMs: num(last.uptime_ms),
    outcome,
    weightUp: lastSwitch ? lastSwitch.limit_switch_pressed! : null,
    batteryMv: num(woke?.battery_mv_est),
    batteryAdcMv: num(woke?.battery_adc_mv),
    resetReason: str(woke?.reset_reason),
    wakeupCause: str(woke?.wakeup_cause),
    wifiRssi: num(woke?.wifi_rssi),
    freeHeap: num(woke?.free_heap),
    minFreeHeap: num(woke?.min_free_heap),
    build: str(woke?.build),
    wifiMs: between("CONNECTING_TO_WIFI", "WIFI_CONNECTED"),
    ntpMs: between("WIFI_CONNECTED", "CLOCK_SET"),
    raiseMs: between("STARTING_RAISE_WEIGHT", "FINISHED_RAISE_WEIGHT") ?? between("STARTING_RAISE_WEIGHT", "RAISE_WEIGHT_FAILURE"),
    events: stamped,
  };
}

// Events logged before NTP sync carry a 1970 unix_time, so wall-clock times are rebuilt from
// uptime_ms against a single anchor: the latest event with a valid clock, or failing that,
// the moment the server received the packet (which is sent right after the last event).
function timestamper(events: RawEvent[], receivedAt: number): (e: RawEvent) => number {
  const withUptime = events.filter((e) => num(e.uptime_ms) !== null);
  const anchor = [...withUptime].reverse().find((e) => e.clock_valid === true && num(e.unix_time) !== null);
  let bootAt: number;
  if (anchor) {
    bootAt = anchor.unix_time! * 1000 - anchor.uptime_ms!;
  } else {
    const lastUptime = withUptime.length ? withUptime[withUptime.length - 1].uptime_ms! : 0;
    bootAt = receivedAt - lastUptime;
  }
  return (e) => {
    const up = num(e.uptime_ms);
    if (up !== null) return Math.round(bootAt + up);
    if (e.clock_valid === true && num(e.unix_time) !== null) return e.unix_time! * 1000;
    return receivedAt;
  };
}
