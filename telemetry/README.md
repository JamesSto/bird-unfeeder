# Bird unfeeder telemetry

Receives the JSON event array the firmware POSTs at the end of every wake
(`arduino/bird_unfeeder/telemetry.cpp`), stores one row per wake in SQLite, and serves a dashboard.

```sh
npm install
cp .env.example .env        # optional; defaults match the firmware
npm run build && npm start  # http://localhost:8787
npm run dev                 # watch mode
```

Everything (ingest and dashboard) sits behind basic auth, with the same credentials as the
firmware's `post()`: `admin` / `rogerDodger` unless `AUTH_USER`/`AUTH_PASSWORD` are set.

The device can POST to `/send_telemetry` (what the firmware uses), `/api/telemetry`, `/telemetry` or `/`.

## Fake data

```sh
DB_PATH=data/sim.db npm run simulate -- backfill 30   # 30 days of history
npm run simulate -- live                              # one wake every 15 min to the running server
```

## How wakes are interpreted

- **Mode** is the limit switch at the end of the wake: pressed = weight up = someone home.
  `FOUND_CLOCK_STATE_*` is ignored because the firmware always reports HOME there.
- **Timestamps** are rebuilt from `uptime_ms` against the latest event with a valid clock, or against
  the time the server received the packet if NTP never synced.
- **Offline** means no check-in for `OFFLINE_AFTER_MS` (1 hour, i.e. about four missed 15-minute wakes). Wakes where Wi-Fi fails never
  reach the server, so they show up as gaps.
- **Battery life** (`src/battery.ts`) fits a trend plus a 24-hour cycle to estimated charge %
  over real wakes since the last swap (an upward jump of more than 40 mV), up to 30 days. The
  voltage has a daily cycle of about ±4 mV, likely temperature, which a straight-line fit
  mistakes for drain. Fitting on % rather than mV allows for the LiPo's voltage dropping off a
  cliff near empty. It needs 3 days of readings after a swap. The % comes from a rough LiPo curve
  and assumes the ×2 divider in the firmware is right, so treat it as a ballpark.
- **Test data** is inferred (`src/classify.ts`) and hidden unless "Show test data" is switched on.
  A wake counts as testing if it's a timer wake less than 10 minutes after the previous wake
  (faster than the 15-minute polling period), or a manual reset (power on, reset pin, etc.)
  followed by a fast wake or another manual reset within the hour. Brownouts, crashes and
  watchdog resets are never hidden. A lone power-on followed by normal wakes (a battery swap)
  counts as real. Set `WAKE_INTERVAL_MS` if the polling period changes.
