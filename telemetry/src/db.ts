import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Wake } from "./packet.ts";

export type WakeRow = {
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
};

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS wakes (
        id             INTEGER PRIMARY KEY,
        received_at    INTEGER NOT NULL,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER NOT NULL,
        clock_valid    INTEGER NOT NULL,
        awake_ms       INTEGER,
        outcome        TEXT NOT NULL,
        weight_up      INTEGER,
        battery_mv     INTEGER,
        battery_adc_mv INTEGER,
        reset_reason   TEXT,
        wakeup_cause   TEXT,
        wifi_rssi      INTEGER,
        free_heap      INTEGER,
        min_free_heap  INTEGER,
        build          TEXT,
        wifi_ms        INTEGER,
        ntp_ms         INTEGER,
        raise_ms       INTEGER,
        events         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wakes_started_at ON wakes (started_at);
    `);
  }

  insert(w: Wake): number {
    const res = this.db
      .prepare(
        `INSERT INTO wakes (received_at, started_at, ended_at, clock_valid, awake_ms, outcome, weight_up,
           battery_mv, battery_adc_mv, reset_reason, wakeup_cause, wifi_rssi, free_heap, min_free_heap,
           build, wifi_ms, ntp_ms, raise_ms, events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.receivedAt,
        w.startedAt,
        w.endedAt,
        w.clockValid ? 1 : 0,
        w.awakeMs,
        w.outcome,
        w.weightUp === null ? null : w.weightUp ? 1 : 0,
        w.batteryMv,
        w.batteryAdcMv,
        w.resetReason,
        w.wakeupCause,
        w.wifiRssi,
        w.freeHeap,
        w.minFreeHeap,
        w.build,
        w.wifiMs,
        w.ntpMs,
        w.raiseMs,
        JSON.stringify(w.events),
      );
    return Number(res.lastInsertRowid);
  }

  transaction(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  latest(): WakeRow | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM wakes ORDER BY started_at DESC LIMIT 1`).get() as WakeRow | undefined;
  }

  // Most recent wake that reported a battery reading (every wake should, but be safe).
  latestWith(column: "battery_mv"): WakeRow | undefined {
    return this.db
      .prepare(`SELECT ${COLS} FROM wakes WHERE ${column} IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
      .get() as WakeRow | undefined;
  }

  lastWithWeight(up: 0 | 1): WakeRow | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM wakes WHERE weight_up = ? ORDER BY started_at DESC LIMIT 1`).get(up) as WakeRow | undefined;
  }

  firstAfter(t: number): WakeRow | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM wakes WHERE started_at > ? ORDER BY started_at LIMIT 1`).get(t) as WakeRow | undefined;
  }

  // Lightweight per-wake rows for building the mode timeline and coverage.
  points(from: number, to: number): Array<{ t: number; e: number; up: number | null }> {
    return this.db
      .prepare(`SELECT started_at AS t, ended_at AS e, weight_up AS up FROM wakes WHERE started_at >= ? AND started_at < ? ORDER BY started_at`)
      .all(from, to) as Array<{ t: number; e: number; up: number | null }>;
  }

  buckets(from: number, to: number, size: number) {
    return this.db
      .prepare(
        // node:sqlite binds JS numbers as REAL; cast so this is integer division.
        `SELECT (started_at / CAST(:size AS INTEGER)) * CAST(:size AS INTEGER) AS t,
                COUNT(*)                     AS n,
                AVG(battery_mv)              AS battery_avg,
                MIN(battery_mv)              AS battery_min,
                MAX(battery_mv)              AS battery_max,
                AVG(awake_ms)                AS awake_avg,
                AVG(wifi_ms)                 AS wifi_avg,
                AVG(ntp_ms)                  AS ntp_avg,
                AVG(NULLIF(wifi_rssi, 0))    AS rssi_avg
         FROM wakes WHERE started_at >= :from AND started_at < :to
         GROUP BY 1 ORDER BY 1`,
      )
      .all({ size, from, to }) as Array<{
      t: number;
      n: number;
      battery_avg: number | null;
      battery_min: number | null;
      battery_max: number | null;
      awake_avg: number | null;
      wifi_avg: number | null;
      ntp_avg: number | null;
      rssi_avg: number | null;
    }>;
  }

  batterySince(from: number): Array<{ t: number; v: number }> {
    return this.db
      .prepare(`SELECT started_at AS t, battery_mv AS v FROM wakes WHERE started_at >= ? AND battery_mv IS NOT NULL ORDER BY started_at`)
      .all(from) as Array<{ t: number; v: number }>;
  }

  motorRuns(from: number, to: number) {
    return this.db
      .prepare(
        `SELECT id, started_at AS t, outcome, raise_ms FROM wakes
         WHERE started_at >= ? AND started_at < ? AND outcome IN ('raised', 'lowered', 'raise_failed')
         ORDER BY started_at`,
      )
      .all(from, to) as Array<{ id: number; t: number; outcome: string; raise_ms: number | null }>;
  }

  tally(column: "outcome" | "reset_reason", from: number, to: number) {
    return this.db
      .prepare(`SELECT COALESCE(${column}, 'unknown') AS k, COUNT(*) AS n FROM wakes WHERE started_at >= ? AND started_at < ? GROUP BY 1 ORDER BY n DESC`)
      .all(from, to) as Array<{ k: string; n: number }>;
  }

  recent(from: number, to: number, limit: number): WakeRow[] {
    return this.db
      .prepare(`SELECT ${COLS} FROM wakes WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC LIMIT ?`)
      .all(from, to, limit) as WakeRow[];
  }

  events(id: number): unknown[] | undefined {
    const row = this.db.prepare(`SELECT events FROM wakes WHERE id = ?`).get(id) as { events: string } | undefined;
    return row ? JSON.parse(row.events) : undefined;
  }

  close() {
    this.db.close();
  }
}

const COLS = `id, received_at, started_at, ended_at, clock_valid, awake_ms, outcome, weight_up, battery_mv,
  battery_adc_mv, reset_reason, wakeup_cause, wifi_rssi, free_heap, min_free_heap, build, wifi_ms, ntp_ms, raise_ms`;
