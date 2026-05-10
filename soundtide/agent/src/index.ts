import { config } from "./config.js";
import { logger } from "./log.js";
import { db } from "./db/index.js";
import { DeviceRegistry } from "./discovery/registry.js";
import { EmbeddedMediaServer } from "./upnp/mediaserver.js";
import { RadioBrowser } from "./radio/radioBrowser.js";
import { DlnaBrowser } from "./nas/dlnaBrowser.js";
import { PlaybackService } from "./playback.js";
import { Scheduler } from "./scheduler/runner.js";
import { TunnelClient } from "./tunnel/client.js";
import { buildServer, makeTunnelHandler } from "./api/server.js";

const log = logger("main");

async function main() {
  log.info("SoundTide agent starting");

  // Soft-land stream errors so a misbehaving upstream radio source can't crash
  // the whole agent. We log them; the proxy itself handles per-stream cleanup.
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "ERR_STREAM_PREMATURE_CLOSE" || err.code === "ECONNRESET") {
      log.warn(`swallowed stream error ${err.code}`);
      return;
    }
    log.error(`uncaughtException`, { err: err.stack ?? String(err) });
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`unhandledRejection`, { reason: String(reason) });
  });

  // Discovery + speaker control.
  const registry = new DeviceRegistry();
  registry.start();

  // Persist newly-seen devices so the PWA has something to show before discovery completes
  // on the next boot.
  registry.on("device:added", (d: any) => {
    db.upsertDevice({
      id: d.deviceId, name: d.name, type: d.type, ip: d.ip,
      software_version: d.softwareVersion ?? null,
      has_bass: d.hasBass ? 1 : 0, has_aux: d.hasAux ? 1 : 0,
    });
  });

  // Local UPnP MediaServer that lets the speakers fetch arbitrary stream URLs.
  const ms = new EmbeddedMediaServer(config.upnpPort);
  ms.start();

  // External directories.
  const radio = new RadioBrowser();
  await radio.chooseHost();
  const dlna = new DlnaBrowser();
  await dlna.start();

  // Make MS lazy: when the speaker asks for a /stream/r-<uuid> we don't
  // currently know about (typically after an agent restart), look the
  // station up against radio-browser and re-publish on the fly so saved
  // presets keep working.
  ms.setLazyResolver(async (id) => {
    const m = id.match(/^r-([a-f0-9-]+)$/i);
    if (!m) return null;
    const station = await radio.byUuid(m[1]!);
    if (!station) return null;
    return {
      id,
      title: station.name,
      upstreamUrl: station.url,
      mime: radio.guessMime(station),
      creator: station.country || undefined,
    };
  });

  // Playback orchestrator.
  const playback = new PlaybackService(registry, ms, radio);

  // Hardware preset interception.
  registry.on("speaker:event", async (ev: any) => {
    if (ev.type === "nowSelectionUpdated" && ev.presetId && ev.presetId >= 1 && ev.presetId <= 6) {
      try { await playback.onHardwarePreset(ev.deviceId, ev.presetId); }
      catch (e) { log.warn("hardware preset run failed", { err: String(e) }); }
    }
  });

  // Cron-based scheduler.
  const scheduler = new Scheduler(async (s) => {
    if (s.scene_id) {
      const scene = db.getScene(s.scene_id);
      if (scene) await playback.applyScene(scene);
    }
    const preset = db.getPreset(s.preset_id);
    if (preset) {
      // If the schedule overrides volume, ramp it.
      if (s.ramp_from != null && s.ramp_to != null && s.ramp_seconds != null) {
        const targets = preset.speaker_id
          ? [preset.speaker_id]
          : (preset.scene_id ? (() => {
              const sc = db.getScene(preset.scene_id!);
              return sc ? [sc.master_id, ...JSON.parse(sc.slave_ids) as string[]] : [];
            })() : []);
        for (const id of targets) {
          const c = registry.client(id);
          if (c) c.setVolume(s.ramp_from).catch(() => undefined);
        }
        // start playback first, then ramp.
        await playback.runPreset(preset).catch((e) => log.warn("preset failed", { err: String(e) }));
        const steps = Math.max(1, Math.floor(s.ramp_seconds / 1));
        const dv = (s.ramp_to - s.ramp_from) / steps;
        for (let i = 1; i <= steps; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const v = Math.round(s.ramp_from + dv * i);
          for (const id of targets) {
            const c = registry.client(id);
            if (c) c.setVolume(v).catch(() => undefined);
          }
        }
      } else {
        await playback.runPreset(preset);
      }
    }
  });
  scheduler.start();

  // PWA-facing API.
  const app = await buildServer({ registry, playback, radio, dlna });
  await app.listen({ host: "0.0.0.0", port: config.httpPort });
  log.info(`http listening on :${config.httpPort}`);

  // Off-LAN tunnel.
  const tunnel = new TunnelClient(makeTunnelHandler(app));
  tunnel.start();

  process.on("SIGINT", async () => {
    log.info("shutting down");
    scheduler.stop();
    registry.stop();
    ms.stop();
    await app.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
