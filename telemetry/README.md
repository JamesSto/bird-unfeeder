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
npm run simulate -- live                              # one wake/minute to the running server
```

## How wakes are interpreted

- **Mode** is the limit switch at the end of the wake: pressed = weight up = someone home.
  `FOUND_CLOCK_STATE_*` is ignored because the firmware always reports HOME there.
- **Timestamps** are rebuilt from `uptime_ms` against the latest event with a valid clock, or against
  the time the server received the packet if NTP never synced.
- **Offline** means no check-in for `OFFLINE_AFTER_MS` (1 hour). Wakes where Wi-Fi fails never
  reach the server, so they show up as gaps.
