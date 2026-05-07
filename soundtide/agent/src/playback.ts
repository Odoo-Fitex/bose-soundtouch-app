import { logger } from "./log.js";
import { db, type PresetRow, type SceneRow } from "./db/index.js";
import { DeviceRegistry } from "./discovery/registry.js";
import { EmbeddedMediaServer } from "./upnp/mediaserver.js";
import { RadioBrowser, type RadioStation } from "./radio/radioBrowser.js";
import { SoundTouchClient } from "./soundtouch/client.js";
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
    const id = `r/${station.uuid}`;
    const url = this.ms.publish({
      id,
      title: station.name,
      upstreamUrl: station.url,
      mime: this.radio.guessMime(station),
      creator: station.country || undefined,
    });
    const item: ContentItem = {
      source: "UPNP",
      sourceAccount: "SoundTide",
      location: url,
      itemName: station.name || "Radio",
      isPresetable: true,
    };
    await this.fanOut(item, target);
    this.radio.click(station.uuid).catch(() => undefined);
  }

  async playRawUrl(url: string, mime: string, label: string, target: { speakerId?: string; sceneId?: string }) {
    const id = `u/${Buffer.from(url).toString("base64url").slice(0, 32)}`;
    const streamUrl = this.ms.publish({ id, title: label, upstreamUrl: url, mime });
    const item: ContentItem = { source: "UPNP", sourceAccount: "SoundTide", location: streamUrl, itemName: label, isPresetable: true };
    await this.fanOut(item, target);
  }

  async playNasUrl(url: string, mime: string, label: string, target: { speakerId?: string; sceneId?: string }) {
    // For NAS DLNA URLs the speaker can fetch them directly.
    const item: ContentItem = { source: "UPNP", sourceAccount: "Synology", location: url, itemName: label, isPresetable: true };
    await this.fanOut(item, target);
  }

  async playAux(speakerId: string, account: "AUX" | "AUX1" | "AUX2" | "AUX3" = "AUX") {
    await this.client(speakerId).select({ source: "AUX", sourceAccount: account });
  }

  async playBluetooth(speakerId: string) {
    await this.client(speakerId).select({ source: "BLUETOOTH" });
  }

  // ---- presets ---------------------------------------------------------------

  async runPreset(preset: PresetRow) {
    const target: { speakerId?: string; sceneId?: string } = {};
    if (preset.speaker_id) target.speakerId = preset.speaker_id;
    if (preset.scene_id) target.sceneId = preset.scene_id;

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
        if (!preset.speaker_id) throw new Error("AUX presets need a speaker");
        await this.playAux(preset.speaker_id, "AUX");
        return;
      }
      case "spotify_uri":
        // We can't actually drive Spotify without the cloud — present a deep link in the UI.
        throw new Error("Spotify presets are deep links, not playback");
      case "raw": {
        const payload = JSON.parse(preset.payload) as { item: ContentItem };
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

  // ---- fan-out helper --------------------------------------------------------

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
}
