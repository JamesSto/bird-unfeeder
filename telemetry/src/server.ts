import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { Store } from "./db.ts";
import { PacketError, parsePacket } from "./packet.ts";
import { buildSummary } from "./summary.ts";

const PORT = Number(process.env.PORT ?? 8787);
const store = new Store(process.env.DB_PATH ?? "data/telemetry.db");
const app = new Hono();

const auth = (user?: string, password?: string) =>
  user && password ? basicAuth({ username: user, password }) : async (_c: unknown, next: () => Promise<void>) => next();

// Device ingest. The firmware posts to TELEMETRY_URL from secrets.h, so accept the common paths.
const INGEST_PATHS = ["/api/telemetry", "/telemetry", "/"];
app.on("POST", INGEST_PATHS, auth(process.env.INGEST_USER, process.env.INGEST_PASSWORD), bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body is not JSON" }, 400);
  }
  try {
    const wake = parsePacket(body, Date.now());
    const id = store.insert(wake);
    console.log(`wake ${id}: ${wake.outcome}, weight ${wake.weightUp ? "up" : "down"}, ${wake.batteryMv ?? "?"} mV`);
    return c.json({ ok: true, id });
  } catch (e) {
    if (e instanceof PacketError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Dashboard + read API.
app.use("*", auth(process.env.DASHBOARD_USER, process.env.DASHBOARD_PASSWORD));

app.get("/api/summary", (c) => {
  const now = Date.now();
  const to = Number(c.req.query("to") ?? now);
  const from = Number(c.req.query("from") ?? now - 86_400_000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return c.json({ error: "bad from/to" }, 400);
  return c.json(buildSummary(store, from, to, now));
});

app.get("/api/wakes/:id/events", (c) => {
  const events = store.events(Number(c.req.param("id")));
  return events ? c.json(events) : c.json({ error: "not found" }, 404);
});

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`bird-unfeeder telemetry on http://localhost:${info.port}`);
  if (!process.env.INGEST_USER) console.warn("INGEST_USER/INGEST_PASSWORD not set: accepting unauthenticated telemetry");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.close();
    process.exit(0);
  });
}
