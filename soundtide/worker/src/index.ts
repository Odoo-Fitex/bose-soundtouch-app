import { Hono } from "hono";
import { cors } from "hono/cors";
import { Tunnel } from "./tunnel.js";

export { Tunnel };

interface Env {
  TUNNEL: DurableObjectNamespace;
  DB: D1Database;
  HOUSEHOLD_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));

// ---- single-household auth -----------------------------------------------
function checkAuth(c: any): boolean {
  const tokenHeader = c.req.header("authorization") ?? "";
  const tokenQuery = c.req.query("token") ?? "";
  const presented = tokenHeader.replace(/^Bearer\s+/i, "") || tokenQuery;
  return presented && presented === c.env.HOUSEHOLD_TOKEN;
}

// ---- tunnel endpoints ----------------------------------------------------

// The Pi connects here over WebSocket and stays connected.
app.get("/tunnel", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 400);
  if (!checkAuth(c)) return c.text("unauthorized", 401);
  const id = c.env.TUNNEL.idFromName("default");
  const stub = c.env.TUNNEL.get(id);
  return stub.fetch(c.req.raw);
});

// The PWA, when off-LAN, calls this with a normal HTTPS request and we forward
// it through the Durable Object to the Pi.
app.all("/agent/*", async (c) => {
  if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const id = c.env.TUNNEL.idFromName("default");
  const stub = c.env.TUNNEL.get(id);
  const path = c.req.path.replace(/^\/agent/, "") || "/";
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
  // Read the raw text body once (Hono will only let us consume the stream a
  // single time) and then try to interpret it as JSON. If parsing fails we
  // forward the original string instead.
  let body: unknown = undefined;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const raw = await c.req.text();
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
  }
  const res = await stub.fetch("https://internal/__forward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: c.req.method, path, headers, body }),
  });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
});

// ---- D1-backed mirror of presets/scenes/schedules ------------------------
// The Pi pushes whole-table snapshots when it has connectivity. The PWA reads
// these only when the tunnel is down (truly offline scenario), as a backup.

app.post("/mirror/snapshot", async (c) => {
  if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const { household_id, presets, scenes, schedules } = await c.req.json() as any;
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM presets WHERE household_id = ?`).bind(household_id),
    c.env.DB.prepare(`DELETE FROM scenes WHERE household_id = ?`).bind(household_id),
    c.env.DB.prepare(`DELETE FROM schedules WHERE household_id = ?`).bind(household_id),
  ]);
  for (const p of presets ?? []) {
    await c.env.DB.prepare(`
      INSERT INTO presets (id, household_id, slot, speaker_id, scene_id, label, artwork_url, kind, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(p.id, household_id, p.slot, p.speaker_id, p.scene_id, p.label, p.artwork_url, p.kind, p.payload, p.created_at, p.updated_at).run();
  }
  for (const s of scenes ?? []) {
    await c.env.DB.prepare(`
      INSERT INTO scenes (id, household_id, label, master_id, slave_ids, default_volume, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(s.id, household_id, s.label, s.master_id, s.slave_ids, s.default_volume, s.created_at).run();
  }
  for (const s of schedules ?? []) {
    await c.env.DB.prepare(`
      INSERT INTO schedules (id, household_id, label, cron, scene_id, speaker_id, preset_id, ramp_from, ramp_to, ramp_seconds, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(s.id, household_id, s.label, s.cron, s.scene_id, s.speaker_id, s.preset_id, s.ramp_from, s.ramp_to, s.ramp_seconds, s.enabled, s.created_at).run();
  }
  return c.json({ ok: true });
});

app.get("/mirror/presets", async (c) => {
  if (!checkAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const r = await c.env.DB.prepare(`SELECT * FROM presets`).all();
  return c.json(r.results);
});

app.get("/health", (c) => c.json({ ok: true, time: Date.now() }));

export default app;
