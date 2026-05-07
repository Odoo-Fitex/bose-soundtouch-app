import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import wol from "wol";
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

  // ---- devices ----------------------------------------------------------------
  app.get("/devices", async () => deps.registry.list());

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
    await deps.playback.runPreset(p);
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
