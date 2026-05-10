import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import wol from "wol";
import net from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../log.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { Scheduler } from "../scheduler/runner.js";
import type { DeviceRegistry } from "../discovery/registry.js";
import type { PlaybackService } from "../playback.js";
import type { RadioBrowser } from "../radio/radioBrowser.js";
import type { DlnaBrowser } from "../nas/dlnaBrowser.js";
import type { TunnelRequest, TunnelResponse } from "../tunnel/client.js";

const log = logger("api");

export interface ApiDeps {
  registry: DeviceRegistry;
  playback: PlaybackService;
  radio: RadioBrowser;
  dlna: DlnaBrowser;
}

export async function buildServer(deps: ApiDeps) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // ---- health -----------------------------------------------------------------
  app.get("/health", async () => ({ ok: true, version: "0.1.0", time: Date.now() }));

  // ---- diagnostics ------------------------------------------------------------
  // Manually probe an IP + port to figure out why discovery isn't adopting it.
  // Returns a structured report that distinguishes:
  //   tcp:ok / tcp:refused / tcp:timeout / tcp:unreachable
  //   http:ok / http:status:xxx / http:abort / http:err:CODE
  // This is the first thing to hit when SSDP says "I see 192.168.x.y" but
  // nothing shows up in the room strip.
  app.get("/diag/probe", async (req) => {
    const q = req.query as { ip?: string; port?: string; timeoutMs?: string };
    const ip = (q.ip || "").trim();
    if (!ip) return { error: "ip query parameter required" };
    const port = Number(q.port || 8090);
    const timeoutMs = Math.min(Number(q.timeoutMs || 4000), 10_000);

    const tcp = await tcpConnectCheck(ip, port, timeoutMs);
    let http: any = { skipped: true };
    if (tcp.ok) {
      // Only bother with HTTP if TCP came up cleanly.
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
      try {
        const r = await fetch(`http://${ip}:${port}/info`, { signal: ac.signal });
        const body = await r.text();
        http = { ok: r.ok, status: r.status, snippet: body.slice(0, 240) };
      } catch (e) {
        const err = e as { name?: string; message?: string; cause?: { code?: string } };
        http = {
          ok: false,
          err: err?.cause?.code || err?.name || "unknown",
          message: err?.message || String(e),
        };
      } finally {
        clearTimeout(t);
      }
    }
    return { ip, port, tcp, http };
  });

  // ---- devices ----------------------------------------------------------------
  app.get("/devices", async () => deps.registry.list());

  // Force an immediate SSDP M-SEARCH and re-probe of every known IP, then
  // return the resulting device list. The PWA's "Rescan" button hits this so
  // a user who just powered up a speaker doesn't have to wait for the next
  // scheduled scan cycle.
  app.post("/devices/rescan", async () => {
    const result = await deps.registry.rescan();
    return { ok: true, ...result, devices: deps.registry.list() };
  });

  app.get("/devices/:id/state", async (req, reply) => {
    const id = (req.params as any).id as string;
    const c = deps.registry.client(id);
    if (!c) return reply.code(404).send({ error: "unknown" });
    const [info, vol, np, zone] = await Promise.all([c.info(), c.volume(), c.nowPlaying(), c.zone()]);
    return { info, volume: vol, nowPlaying: np, zone };
  });

  app.post("/devices/:id/key", async (req, reply) => {
    const id = (req.params as any).id as string;
    const { key } = req.body as { key: string };
    const c = deps.registry.client(id);
    if (!c) return reply.code(404).send({ error: "unknown" });
    await c.key(key as any);
    return { ok: true };
  });

  app.post("/devices/:id/volume", async (req, reply) => {
    const id = (req.params as any).id as string;
    const { volume, muted } = req.body as { volume?: number; muted?: boolean };
    const c = deps.registry.client(id);
    if (!c) return reply.code(404).send({ error: "unknown" });
    if (volume !== undefined) await c.setVolume(volume);
    if (muted !== undefined) await c.setMute(muted);
    return { ok: true };
  });

  app.post("/devices/:id/select", async (req, reply) => {
    const id = (req.params as any).id as string;
    const item = req.body as any;
    const c = deps.registry.client(id);
    if (!c) return reply.code(404).send({ error: "unknown" });
    await c.select(item);
    return { ok: true };
  });

  app.post("/devices/:id/name", async (req, reply) => {
    const id = (req.params as any).id as string;
    const { name } = req.body as { name: string };
    const c = deps.registry.client(id);
    if (!c) return reply.code(404).send({ error: "unknown" });
    await c.setName(name);
    return { ok: true };
  });

  // ---- presets ----------------------------------------------------------------
  app.get("/presets", async (req) => {
    const speakerId = (req.query as any).speakerId as string | undefined;
    return db.listPresets(speakerId);
  });

  app.put("/presets", async (req) => {
    const body = req.body as any;
    return db.upsertPreset(body);
  });

  app.delete("/presets/:id", async (req) => {
    db.deletePreset((req.params as any).id);
    return { ok: true };
  });

  app.post("/presets/:id/play", async (req, reply) => {
    const p = db.getPreset((req.params as any).id);
    if (!p) return reply.code(404).send({ error: "unknown" });
    // Accept an optional `speakerId` override so the UI can route playback to
    // whichever room the user has currently selected — the preset's stored
    // speaker_id is used as a fallback only. Without this override, every
    // preset would play on whatever room it was saved against, which is wildly
    // unintuitive when you've just tapped a different room pill.
    const body = (req.body ?? {}) as { speakerId?: string; sceneId?: string };
    log.info(`/presets/:id/play`, { id: p.id, label: p.label, bound: p.speaker_id, override: body.speakerId });
    await deps.playback.runPreset(p, { speakerId: body.speakerId, sceneId: body.sceneId });
    return { ok: true };
  });

  // ---- ad-hoc zones (live grouping from Now Playing) -------------------------
  // The selected speaker is treated as master. Add/remove slaves on demand.

  app.post("/devices/:id/zone/add", async (req, reply) => {
    const masterId = (req.params as any).id as string;
    const { slaveId } = req.body as { slaveId: string };
    const master = deps.registry.byId(masterId);
    const slave = deps.registry.byId(slaveId);
    if (!master || !slave) return reply.code(404).send({ error: "unknown speaker" });

    // Pre-check: is the slave actually reachable on the LAN right now?
    // The master happily acks /addZoneSlave even if the slave is asleep,
    // which leads to silent "click does nothing" UX in the PWA.
    const slaveClient = deps.registry.client(slave.deviceId)!;
    try {
      await slaveClient.info();
    } catch (e) {
      return reply.code(409).send({
        error: `${slave.name} is not reachable (${slave.ip}). Power it on, then try again.`,
        cause: String(e),
      });
    }

    const masterClient = deps.registry.client(master.deviceId)!;

    // Per the API doc and libsoundtouch, /addZoneSlave only works on an
    // already-existing zone — it silently no-ops on a solo master. Use
    // /setZone with the full intended membership instead, which both creates
    // zones from scratch and extends existing ones.
    let existingZone;
    try { existingZone = await masterClient.zone(); } catch { existingZone = { master: null, members: [] }; }
    const existingSlaves = existingZone.members
      .filter(m => m.deviceId.toUpperCase() !== master.deviceId.toUpperCase())
      .map(m => {
        const dev = deps.registry.byId(m.deviceId);
        return dev ? { deviceId: dev.deviceId, ip: dev.ip } : null;
      })
      .filter((x): x is { deviceId: string; ip: string } => !!x);
    // Don't double-add; if the slave is already in there, just early-return ok.
    const alreadyIn = existingSlaves.some(s => s.deviceId.toUpperCase() === slave.deviceId.toUpperCase());
    const fullSlaves = alreadyIn
      ? existingSlaves
      : [...existingSlaves, { deviceId: slave.deviceId, ip: slave.ip }];
    await masterClient.setZone(
      { deviceId: master.deviceId, ip: master.ip },
      fullSlaves,
    );

    // Post-verify: did the slave actually join the master's zone?
    // Be patient — some firmware updates /getZone slowly. Poll a few times.
    const wantId = slave.deviceId.toUpperCase();
    let joined = false;
    let lastZone: { master: string | null; members: { deviceId: string; ip: string }[] } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 400));
      lastZone = await masterClient.zone();
      log.debug(`zone after add (attempt ${attempt + 1})`, { zone: lastZone });
      if (lastZone.members.some(m => m.deviceId.toUpperCase() === wantId)) {
        joined = true;
        break;
      }
    }
    if (!joined) {
      return reply.code(409).send({
        error: `${slave.name} accepted the request but did not actually join the zone. It may be on a different network or refused by the master.`,
        observedZone: lastZone,
      });
    }

    // ---- Multi-speaker debug snapshot ---------------------------------------
    // After a successful zone-add, ask each member of the resulting zone what
    // it thinks is going on. We dump:
    //   • its /getZone (does it know it's a slave/master?)
    //   • its /now_playing (is it streaming the same source as the master?)
    //   • its /volume (muted? at zero?)
    // This is what we need to see to figure out why audio isn't coming out of
    // the third speaker even though setZone says all three are in the zone.
    try {
      const everyone = [
        { deviceId: master.deviceId, ip: master.ip, role: "master" },
        ...fullSlaves.map(s => ({ deviceId: s.deviceId, ip: s.ip, role: "slave" })),
      ];
      const snapshot = await Promise.all(everyone.map(async (m) => {
        const c = deps.registry.client(m.deviceId);
        if (!c) return { ...m, error: "no client" };
        const [zoneState, np, vol] = await Promise.allSettled([c.zone(), c.nowPlaying(), c.volume()]);
        return {
          name: deps.registry.byId(m.deviceId)?.name ?? m.deviceId,
          deviceId: m.deviceId,
          ip: m.ip,
          role: m.role,
          zone: zoneState.status === "fulfilled" ? zoneState.value : { err: String((zoneState as any).reason) },
          nowPlaying: np.status === "fulfilled" ? {
            source: np.value.source,
            playStatus: np.value.playStatus,
            track: np.value.track,
            stationName: np.value.stationName,
            location: np.value.contentItem?.location,
          } : { err: String((np as any).reason) },
          volume: vol.status === "fulfilled" ? vol.value : { err: String((vol as any).reason) },
        };
      }));
      log.info(`zone-add snapshot (master=${master.deviceId}, +${slave.deviceId})`, {
        size: snapshot.length,
        members: snapshot,
      });
    } catch (e) {
      log.warn(`zone-add snapshot failed`, { err: String(e) });
    }

    return { ok: true };
  });

  // ---- Diagnostic: inspect a zone from every member's POV --------------------
  // GET /diag/zone?id=<masterId>  →  returns the same snapshot we log on add,
  // on demand. Useful for "the third speaker is silent — what does it think
  // is happening RIGHT NOW?" without re-running setZone.
  app.get("/diag/zone", async (req, reply) => {
    const id = ((req.query as any).id as string | undefined) ?? "";
    if (!id) return reply.code(400).send({ error: "id query parameter required" });
    const master = deps.registry.byId(id);
    if (!master) return reply.code(404).send({ error: "unknown master" });
    const c = deps.registry.client(master.deviceId)!;
    let zone;
    try { zone = await c.zone(); } catch (e) {
      return reply.code(502).send({ error: `master /getZone failed: ${e}` });
    }
    const memberIds = zone.members.map(m => m.deviceId);
    const everyone = [master.deviceId, ...memberIds.filter(m => m.toUpperCase() !== master.deviceId.toUpperCase())];
    const snapshot = await Promise.all(everyone.map(async (deviceId) => {
      const dev = deps.registry.byId(deviceId);
      const cli = deps.registry.client(deviceId);
      if (!dev || !cli) return { deviceId, error: "not in registry" };
      const [zoneState, np, vol] = await Promise.allSettled([cli.zone(), cli.nowPlaying(), cli.volume()]);
      return {
        name: dev.name,
        deviceId,
        ip: dev.ip,
        role: deviceId.toUpperCase() === master.deviceId.toUpperCase() ? "master" : "slave",
        zone: zoneState.status === "fulfilled" ? zoneState.value : { err: String((zoneState as any).reason) },
        nowPlaying: np.status === "fulfilled" ? np.value : { err: String((np as any).reason) },
        volume: vol.status === "fulfilled" ? vol.value : { err: String((vol as any).reason) },
      };
    }));
    return { master: master.deviceId, masterName: master.name, snapshot };
  });

  app.post("/devices/:id/zone/remove", async (req, reply) => {
    const masterId = (req.params as any).id as string;
    const { slaveId } = req.body as { slaveId: string };
    const master = deps.registry.byId(masterId);
    const slave = deps.registry.byId(slaveId);
    if (!master || !slave) return reply.code(404).send({ error: "unknown speaker" });
    const c = deps.registry.client(master.deviceId)!;
    // /removeZoneSlave is the documented primitive for shrinking a zone.
    // setZone with a smaller member list silently no-ops on this firmware.
    await c.removeZoneSlave({ deviceId: master.deviceId },
      { deviceId: slave.deviceId, ip: slave.ip });
    return { ok: true };
  });

  app.delete("/devices/:id/zone", async (req, reply) => {
    // Dissolve a zone the way the firmware actually accepts: remove each
    // slave one at a time via /removeZoneSlave. setZone with just the master
    // is a no-op once the zone already exists. If the device is itself a
    // slave, ask the master to drop it.
    const id = (req.params as any).id as string;
    const dev = deps.registry.byId(id);
    if (!dev) return reply.code(404).send({ error: "unknown" });
    const c = deps.registry.client(dev.deviceId)!;
    const zone = await c.zone();
    if (!zone.master) return { ok: true };

    const isMaster = zone.master.toUpperCase() === dev.deviceId.toUpperCase();
    if (isMaster) {
      // Drop every slave (everyone in members[] who isn't the master itself).
      for (const m of zone.members) {
        if (m.deviceId.toUpperCase() === dev.deviceId.toUpperCase()) continue;
        const slave = deps.registry.byId(m.deviceId);
        if (!slave) {
          log.warn(`zone slave ${m.deviceId} not in registry; skipping`);
          continue;
        }
        try {
          await c.removeZoneSlave({ deviceId: dev.deviceId },
            { deviceId: slave.deviceId, ip: slave.ip });
        } catch (e) {
          log.warn(`removeZoneSlave ${slave.deviceId} failed`, { err: String(e) });
        }
      }
    } else {
      // We're a slave — tell the master to drop us.
      const masterDev = deps.registry.byId(zone.master);
      if (masterDev) {
        const mc = deps.registry.client(masterDev.deviceId)!;
        await mc.removeZoneSlave({ deviceId: masterDev.deviceId },
          { deviceId: dev.deviceId, ip: dev.ip });
      }
    }
    return { ok: true };
  });

  // ---- scenes -----------------------------------------------------------------
  app.get("/scenes", async () => db.listScenes());

  app.put("/scenes", async (req) => db.upsertScene(req.body as any));

  app.delete("/scenes/:id", async (req) => {
    db.deleteScene((req.params as any).id);
    return { ok: true };
  });

  app.post("/scenes/:id/apply", async (req, reply) => {
    const s = db.getScene((req.params as any).id);
    if (!s) return reply.code(404).send({ error: "unknown" });
    await deps.playback.applyScene(s);
    return { ok: true };
  });

  // ---- schedules --------------------------------------------------------------
  app.get("/schedules", async () => db.listSchedules());
  app.put("/schedules", async (req) => db.upsertSchedule(req.body as any));
  app.delete("/schedules/:id", async (req) => {
    db.deleteSchedule((req.params as any).id);
    return { ok: true };
  });
  app.get("/schedules/preview", async (req) => {
    const cron = (req.query as any).cron as string;
    return Scheduler.preview(cron, 5);
  });

  // ---- radio ------------------------------------------------------------------
  app.get("/radio/search", async (req) => {
    const q = req.query as any;
    return deps.radio.search({
      name: q.name,
      country: q.country,
      tag: q.tag,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });

  app.post("/radio/play", async (req, reply) => {
    const { uuid, speakerId, sceneId } = req.body as { uuid: string; speakerId?: string; sceneId?: string };
    log.info(`/radio/play received`, { uuid, speakerId, sceneId });
    const station = await deps.radio.byUuid(uuid);
    if (!station) return reply.code(404).send({ error: "station not found" });
    await deps.playback.playRadio(station, { speakerId, sceneId });
    return { ok: true };
  });

  // ---- NAS / DLNA -------------------------------------------------------------
  app.get("/nas/servers", async () => deps.dlna.list());

  app.post("/nas/add", async (req, reply) => {
    const { descriptionUrl } = req.body as { descriptionUrl: string };
    const srv = await deps.dlna.add(descriptionUrl);
    if (!srv) return reply.code(400).send({ error: "could not register server" });
    return srv;
  });

  app.get("/nas/:uuid/browse", async (req) => {
    const uuid = (req.params as any).uuid as string;
    const objectId = ((req.query as any).objectId as string | undefined) ?? "0";
    return deps.dlna.browse(uuid, objectId);
  });

  app.post("/nas/play", async (req, reply) => {
    const { url, mime, title, speakerId, sceneId } = req.body as { url: string; mime: string; title: string; speakerId?: string; sceneId?: string };
    await deps.playback.playNasUrl(url, mime, title, { speakerId, sceneId });
    return { ok: true };
  });

  app.post("/nas/wake", async (_req, reply) => {
    if (!config.nasWolMac) return reply.code(400).send({ error: "no NAS MAC configured" });
    await new Promise<void>((res, rej) => wol.wake(config.nasWolMac!, (err: Error | null) => (err ? rej(err) : res())));
    return { ok: true };
  });

  // ---- WS fanout to PWA -------------------------------------------------------
  // The agent already subscribes to each speaker's gabbo WS; this endpoint relays
  // those events to every connected PWA so the UI can update without polling.
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket: any) => {
      const send = (msg: unknown) => {
        try { socket.send(JSON.stringify(msg)); } catch {}
      };
      const onSpeaker = (ev: unknown) => send({ type: "speaker", ev });
      const onAdded = (d: unknown) => send({ type: "device:added", device: d });
      const onOffline = (d: unknown) => send({ type: "device:offline", device: d });
      deps.registry.on("speaker:event", onSpeaker);
      deps.registry.on("device:added", onAdded);
      deps.registry.on("device:offline", onOffline);
      send({ type: "hello", devices: deps.registry.list() });
      socket.on("close", () => {
        deps.registry.off("speaker:event", onSpeaker);
        deps.registry.off("device:added", onAdded);
        deps.registry.off("device:offline", onOffline);
      });
    });
  });

  // ---- Static PWA --------------------------------------------------------------
  // The Dockerfile copies the built PWA bundle to /app/pwa-dist; serve it at /.
  // In dev (running with tsx outside Docker) the directory may be absent and we
  // simply run as an API-only server.
  const candidates = [
    "/app/pwa-dist",
    path.resolve(process.cwd(), "pwa-dist"),
    path.resolve(process.cwd(), "../pwa/dist"),
  ];
  const pwaDir = candidates.find((p) => existsSync(p));
  if (pwaDir) {
    await app.register(fastifyStatic, { root: pwaDir, prefix: "/" });
    log.info(`pwa served from ${pwaDir}`);
  } else {
    log.info("no pwa bundle found — running api-only");
  }

  log.info("api server built");
  return app;
}

/** Raw TCP reachability check that bypasses fetch/undici, so we can tell the
 * difference between "speaker port closed" (refused), "no host on the LAN"
 * (timeout / unreachable) and "speaker accepted us but http stack is down"
 * (tcp ok + http err). */
function tcpConnectCheck(ip: string, port: number, timeoutMs: number):
  Promise<{ ok: boolean; reason?: string; code?: string; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (result: { ok: boolean; reason?: string; code?: string }) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve({ ...result, ms: Date.now() - start });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done({ ok: true, reason: "connected" }));
    sock.once("timeout", () => done({ ok: false, reason: "timeout" }));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED → host is up, port is closed (firmware http server down).
      // EHOSTUNREACH / ENETUNREACH → no route (different VLAN / wrong subnet).
      // ETIMEDOUT → silently dropped (firewall, sleeping speaker).
      done({ ok: false, reason: "error", code: err.code });
    });
    sock.connect(port, ip);
  });
}

/**
 * The same dispatch surface is exposed to the tunnel. We translate envelopes
 * into Fastify-style requests by calling app.inject().
 */
export function makeTunnelHandler(app: Awaited<ReturnType<typeof buildServer>>) {
  return async (req: TunnelRequest): Promise<TunnelResponse> => {
    const res = await app.inject({
      method: req.method as any,
      url: req.path,
      headers: req.headers,
      payload: req.body == null ? undefined : (typeof req.body === "string" ? req.body : JSON.stringify(req.body)),
    });
    let parsed: unknown = res.body;
    try { parsed = JSON.parse(res.body); } catch { /* keep as text */ }
    return { id: req.id, status: res.statusCode, body: parsed };
  };
}
