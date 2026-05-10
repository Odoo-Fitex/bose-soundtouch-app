import { logger } from "./log.js";
import { db, type PresetRow, type SceneRow } from "./db/index.js";
import { DeviceRegistry } from "./discovery/registry.js";
import { EmbeddedMediaServer } from "./upnp/mediaserver.js";
import { RadioBrowser, type RadioStation } from "./radio/radioBrowser.js";
import { SoundTouchClient } from "./soundtouch/client.js";
import { playUrl as dlnaPlayUrl } from "./soundtouch/dlna.js";
import type { ContentItem } from "./soundtouch/types.js";

const log = logger("playback");

export class PlaybackService {
  constructor(
    public registry: DeviceRegistry,
    public ms: EmbeddedMediaServer,
    public radio: RadioBrowser,
  ) {}

  // ---- speaker resolution ----------------------------------------------------

  client(deviceId: string): SoundTouchClient {
    const c = this.registry.client(deviceId);
    if (!c) throw new Error(`unknown speaker ${deviceId}`);
    return c;
  }

  // ---- direct playback by source --------------------------------------------

  async playRadio(station: RadioStation, target: { speakerId?: string; sceneId?: string }) {
    // Track IDs are used inside a URL path; keep them slash-free so the
    // SoundTouch firmware doesn't see a percent-encoded slash and bail out.
    const id = `r-${station.uuid}`;
    const url = this.ms.publish({
      id,
      title: station.name,
      upstreamUrl: station.url,
      mime: this.radio.guessMime(station),
      creator: station.country || undefined,
    });
    await this.dlnaFanOut(url, station.name || "Radio", this.radio.guessMime(station), target);
    this.radio.click(station.uuid).catch(() => undefined);
  }

  async playRawUrl(url: string, mime: string, label: string, target: { speakerId?: string; sceneId?: string }) {
    const id = `u-${Buffer.from(url).toString("base64url").slice(0, 32)}`;
    const streamUrl = this.ms.publish({ id, title: label, upstreamUrl: url, mime });
    await this.dlnaFanOut(streamUrl, label, mime, target);
  }

  async playNasUrl(url: string, mime: string, label: string, target: { speakerId?: string; sceneId?: string }) {
    // For NAS DLNA URLs the speaker can fetch them directly via AVTransport.
    await this.dlnaFanOut(url, label, mime, target);
  }

  async playAux(speakerId: string, account: "AUX" | "AUX1" | "AUX2" | "AUX3" = "AUX") {
    await this.client(speakerId).select({ source: "AUX", sourceAccount: account });
  }

  async playBluetooth(speakerId: string) {
    await this.client(speakerId).select({ source: "BLUETOOTH" });
  }

  // ---- presets ---------------------------------------------------------------

  async runPreset(preset: PresetRow, override: { speakerId?: string; sceneId?: string } = {}) {
    // Resolution order:
    //   1. an explicit override (typically the live $selectedSpeaker from the PWA)
    //   2. the preset's stored binding (speaker_id / scene_id)
    // This means a preset saved against the kitchen will follow the user when
    // they tap "Living room" in the room strip and then play it.
    const target: { speakerId?: string; sceneId?: string } = {};
    if (override.sceneId) target.sceneId = override.sceneId;
    else if (override.speakerId) target.speakerId = override.speakerId;
    else if (preset.scene_id) target.sceneId = preset.scene_id;
    else if (preset.speaker_id) target.speakerId = preset.speaker_id;
    log.debug(`runPreset target`, { presetId: preset.id, target });

    switch (preset.kind) {
      case "radio": {
        const payload = JSON.parse(preset.payload) as { uuid: string };
        const station = await this.radio.byUuid(payload.uuid);
        if (!station) throw new Error("station no longer available");
        await this.playRadio(station, target);
        return;
      }
      case "nas": {
        const payload = JSON.parse(preset.payload) as { url: string; mime: string };
        await this.playNasUrl(payload.url, payload.mime, preset.label, target);
        return;
      }
      case "podcast": {
        const payload = JSON.parse(preset.payload) as { enclosureUrl: string; mime: string };
        await this.playRawUrl(payload.enclosureUrl, payload.mime, preset.label, target);
        return;
      }
      case "aux": {
        // Prefer the live override (current selection) so an AUX preset can be
        // routed to whichever speaker the user is looking at.
        const auxSpeaker = target.speakerId ?? preset.speaker_id;
        if (!auxSpeaker) throw new Error("AUX presets need a speaker");
        await this.playAux(auxSpeaker, "AUX");
        return;
      }
      case "spotify_uri":
        // We can't actually drive Spotify without the cloud — present a deep link in the UI.
        throw new Error("Spotify presets are deep links, not playback");
      case "raw": {
        const payload = JSON.parse(preset.payload) as { item: ContentItem };
        // If the saved ContentItem is a URL-based UPnP item (i.e. one we
        // published through our embedded MediaServer), route it via AVTransport
        // — /select with source="UPNP" only works if the speaker has adopted
        // our server, which is unreliable post-cloud-cut. AVTransport is
        // unconditionally accepted.
        const loc = payload.item.location;
        if (loc && /^https?:\/\//i.test(loc)) {
          const title = payload.item.itemName || preset.label;
          await this.dlnaFanOut(loc, title, "audio/mpeg", target);
          return;
        }
        // Anything else (AUX, BLUETOOTH, PRODUCT, etc.) goes via /select.
        await this.fanOut(payload.item, target);
        return;
      }
    }
  }

  /** Listen for a hardware preset button being pressed and run our preset for that slot. */
  async onHardwarePreset(speakerId: string, slot: number) {
    const p = db.presetForSlot(speakerId, slot);
    if (!p) {
      log.debug(`no preset bound to ${speakerId} slot ${slot}`);
      return;
    }
    log.info(`hardware preset ${slot} on ${speakerId} -> ${p.label}`);
    await this.runPreset(p);
  }

  // ---- zones / scenes --------------------------------------------------------

  async applyScene(scene: SceneRow) {
    const slaveIds = JSON.parse(scene.slave_ids) as string[];
    const master = this.registry.byId(scene.master_id);
    if (!master) throw new Error(`master ${scene.master_id} not on the LAN`);
    const slaves = slaveIds.map(id => this.registry.byId(id)).filter((d): d is NonNullable<typeof d> => !!d);
    await this.client(master.deviceId).setZone(
      { deviceId: master.deviceId, ip: master.ip },
      slaves.map(s => ({ deviceId: s.deviceId, ip: s.ip })),
    );
    if (scene.default_volume != null) {
      await Promise.all([master, ...slaves].map(d => this.client(d.deviceId).setVolume(scene.default_volume!)));
    }
  }

  // ---- fan-out helpers -------------------------------------------------------

  private async fanOut(item: ContentItem, target: { speakerId?: string; sceneId?: string }) {
    if (target.sceneId) {
      const scene = db.getScene(target.sceneId);
      if (!scene) throw new Error(`scene ${target.sceneId} not found`);
      await this.applyScene(scene);
      await this.client(scene.master_id).select(item);
      return;
    }
    if (!target.speakerId) throw new Error("no playback target");
    await this.client(target.speakerId).select(item);
  }

  /** Push a stream URL to the target via DLNA AVTransport on :8091. */
  private async dlnaFanOut(uri: string, title: string, mime: string, target: { speakerId?: string; sceneId?: string }) {
    if (target.sceneId) {
      const scene = db.getScene(target.sceneId);
      if (!scene) throw new Error(`scene ${target.sceneId} not found`);
      await this.applyScene(scene);
      const master = this.registry.byId(scene.master_id);
      if (!master) throw new Error(`master ${scene.master_id} not on the LAN`);
      await this.detachIfSlave(master.deviceId);
      await dlnaPlayUrl(master.ip, uri, title, mime);
      return;
    }
    if (!target.speakerId) throw new Error("no playback target");
    const dev = this.registry.byId(target.speakerId);
    if (!dev) throw new Error(`unknown speaker ${target.speakerId}`);
    log.info(`dlnaFanOut → ${dev.name} (${dev.deviceId} @ ${dev.ip})`);
    await this.detachIfSlave(dev.deviceId);
    await dlnaPlayUrl(dev.ip, uri, title, mime);
  }

  /**
   * If `speakerId` is currently a slave in some zone, detach it (setZone with
   * just itself) so AVTransport push isn't hijacked by the master. Solo or
   * already-master speakers are left alone.
   */
  private async detachIfSlave(speakerId: string): Promise<void> {
    const dev = this.registry.byId(speakerId);
    if (!dev) return;
    const c = this.client(dev.deviceId);
    let zone;
    try { zone = await c.zone(); } catch { return; }
    const idUp = dev.deviceId.toUpperCase();
    const masterUp = (zone.master ?? "").toUpperCase();
    if (!masterUp || masterUp === idUp) return; // solo or already master
    log.info(`detaching ${dev.deviceId} from zone master ${zone.master} before playback`);
    try {
      await c.setZone({ deviceId: dev.deviceId, ip: dev.ip }, []);
      // Give the speaker a moment to settle out of zone-slave audio routing.
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      log.warn(`detach ${dev.deviceId} failed`, { err: String(e) });
    }
  }
}
