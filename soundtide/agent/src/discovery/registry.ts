import { EventEmitter } from "node:events";
import { logger } from "../log.js";
import { probeDevice, SoundTouchClient } from "../soundtouch/client.js";
import { SoundTouchWatcher, type SpeakerEvent } from "../soundtouch/websocket.js";
import { SsdpScanner } from "./ssdp.js";
import { MdnsScanner } from "./mdns.js";
import type { DeviceInfo, SourceItem } from "../soundtouch/types.js";

const log = logger("registry");

export interface KnownDevice extends DeviceInfo {
  ip: string;
  lastSeen: number;
  online: boolean;
  sources: SourceItem[];
}

/**
 * Owns the live map of speakers on the LAN. Combines SSDP and mDNS hits, probes each unique IP
 * once via /info, fans out WebSocket connections, and re-emits a normalised stream of events.
 */
export class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, KnownDevice>(); // by deviceId (MAC)
  private byIp = new Map<string, string>();         // ip -> deviceId
  private watchers = new Map<string, SoundTouchWatcher>();
  private ssdp = new SsdpScanner();
  private mdns = new MdnsScanner();

  start() {
    this.ssdp.on("hit", (hit) => this.adopt(hit.ip, "ssdp"));
    this.mdns.on("hit", (hit) => {
      if (hit.type === "soundtouch") this.adopt(hit.ip, "mdns");
    });
    this.ssdp.start();
    this.mdns.start();
    setInterval(() => this.expire(), 60_000);
  }

  stop() {
    this.ssdp.stop();
    this.mdns.stop();
    for (const w of this.watchers.values()) w.stop();
  }

  list(): KnownDevice[] {
    return [...this.devices.values()];
  }

  byId(deviceId: string): KnownDevice | undefined {
    return this.devices.get(deviceId.toUpperCase());
  }

  client(deviceId: string): SoundTouchClient | null {
    const d = this.byId(deviceId);
    return d ? new SoundTouchClient(d.ip) : null;
  }

  private async adopt(ip: string, source: string) {
    const existingId = this.byIp.get(ip);
    if (existingId) {
      const d = this.devices.get(existingId);
      if (d) {
        d.lastSeen = Date.now();
        d.online = true;
      }
      return;
    }
    log.debug(`adopting ${ip} via ${source}`);
    try {
      const enriched = await probeDevice(ip);
      const dev: KnownDevice = {
        ...enriched,
        lastSeen: Date.now(),
        online: true,
      };
      // Filter to actual SoundTouch devices.
      if (!/SoundTouch/i.test(dev.type) && !/Bose/i.test(dev.type)) {
        log.debug(`skipping non-SoundTouch device ${ip} (${dev.type})`);
        return;
      }
      this.devices.set(dev.deviceId, dev);
      this.byIp.set(ip, dev.deviceId);
      this.emit("device:added", dev);
      this.startWatcher(dev);
    } catch (e) {
      log.debug(`probe ${ip} failed`, { err: String(e) });
    }
  }

  private startWatcher(dev: KnownDevice) {
    if (this.watchers.has(dev.deviceId)) return;
    const w = new SoundTouchWatcher(dev.ip, dev.deviceId);
    w.on("event", (ev: SpeakerEvent) => this.emit("speaker:event", ev));
    w.start();
    this.watchers.set(dev.deviceId, w);
  }

  private expire() {
    const cutoff = Date.now() - 5 * 60_000;
    for (const d of this.devices.values()) {
      if (d.lastSeen < cutoff && d.online) {
        d.online = false;
        this.emit("device:offline", d);
      }
    }
  }
}
