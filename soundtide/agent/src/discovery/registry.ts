import { EventEmitter } from "node:events";
import { logger } from "../log.js";
import { db, type DeviceRow } from "../db/index.js";
import { probeDevice, SoundTouchClient } from "../soundtouch/client.js";
import { SoundTouchWatcher, type SpeakerEvent } from "../soundtouch/websocket.js";
import { SsdpScanner } from "./ssdp.js";
import { MdnsScanner } from "./mdns.js";
import type { DeviceInfo, SourceItem } from "../soundtouch/types.js";

const log = logger("registry");

// How often to re-probe known-but-offline devices. The previous behaviour
// (waiting 60s for the next SSDP cycle) made a powered-off-then-on speaker
// stay grey for a couple of minutes. 15s feels snappy without flooding the LAN.
const OFFLINE_RETRY_MS = 15_000;
// How long without a hit before we mark a device offline. Don't drop it from
// the registry at all — it's a real piece of hardware on the LAN, just maybe
// asleep, and the user will want to see it grey rather than have it disappear.
const OFFLINE_THRESHOLD_MS = 90_000;

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
    // Hydrate from disk so the PWA has speakers to render on the very first
    // request, before discovery completes. Skip awaiting — boot shouldn't
    // block on every speaker on the LAN being reachable.
    this.seedFromDb().catch(e => log.warn("seedFromDb failed", { err: String(e) }));
    // Mark long-silent devices offline (but keep them in the registry) and
    // retry their last-known IPs on a tight cadence.
    setInterval(() => this.expire(), 30_000);
    setInterval(() => this.retryOffline().catch(() => undefined), OFFLINE_RETRY_MS);
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
    const existing = existingId ? this.devices.get(existingId) : undefined;

    // Online-and-known: refresh the timestamp and we're done. This is the
    // hot path during normal operation when SSDP keeps firing.
    if (existing && existing.online) {
      existing.lastSeen = Date.now();
      return;
    }

    // Either brand-new or known-but-offline. Both paths require a real probe.
    log.debug(`adopting ${ip} via ${source}${existing ? " (was offline)" : ""}`);
    try {
      const enriched = await probeDevice(ip);
      // Filter to actual SoundTouch devices. (Other UPnP MediaRenderers on
      // the LAN — TVs, AVRs — show up via SSDP and we don't want to adopt
      // them.)
      if (!/SoundTouch/i.test(enriched.type) && !/Bose/i.test(enriched.type)) {
        log.debug(`skipping non-SoundTouch device ${ip} (${enriched.type})`);
        return;
      }
      const dev: KnownDevice = {
        ...enriched,
        lastSeen: Date.now(),
        online: true,
      };
      const idUp = dev.deviceId.toUpperCase();
      // If this is the same MAC we already had (likely after a Wi-Fi DHCP
      // bounce or a fresh boot), keep the registry entry's identity but
      // refresh fields and emit a re-online event so the UI un-greys it.
      if (existing && existing.deviceId.toUpperCase() === idUp) {
        const wasOffline = !existing.online;
        Object.assign(existing, dev);
        if (wasOffline) {
          log.info(`${dev.name} (${dev.deviceId}) back online @ ${ip}`);
          this.emit("device:added", existing);
          this.startWatcher(existing);
        }
        return;
      }
      // New MAC, possibly recycling an IP. Drop any old byIp entry first.
      if (existing) this.byIp.delete(existing.ip);
      this.devices.set(idUp, dev);
      this.byIp.set(ip, idUp);
      this.emit("device:added", dev);
      this.startWatcher(dev);
    } catch (e) {
      // undici wraps connection-level failures as `TypeError: fetch failed`
      // and stashes the actual reason (ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT,
      // ECONNRESET, …) inside `error.cause`. Surface it so we can tell apart
      // "speaker not on the LAN" from "speaker firmware hung" from "wrong
      // subnet / no route".
      const err = e as { message?: string; cause?: { code?: string; message?: string } };
      const code = err?.cause?.code ?? "";
      const causeMsg = err?.cause?.message ?? err?.message ?? String(e);
      // Demote to debug for the routine "still offline" case; warn for novel
      // failures so we don't spam logs once a device is genuinely unreachable.
      if (existing && !existing.online) log.debug(`probe ${ip} still failing`, { code, source });
      else log.warn(`probe ${ip} failed`, { code, cause: causeMsg, source });
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
    const cutoff = Date.now() - OFFLINE_THRESHOLD_MS;
    for (const d of this.devices.values()) {
      if (d.lastSeen < cutoff && d.online) {
        d.online = false;
        log.info(`marking ${d.name} (${d.deviceId}) offline`);
        this.emit("device:offline", d);
      }
    }
  }

  /** Load every device we've ever seen from sqlite and probe its last-known
   * IP in parallel. Anything that responds is registered as online before
   * the SSDP timer fires for the first time. */
  private async seedFromDb(): Promise<void> {
    let rows: DeviceRow[] = [];
    try { rows = db.listDevices(); } catch (e) {
      log.warn(`db.listDevices failed`, { err: String(e) });
      return;
    }
    if (rows.length === 0) {
      log.info("no known devices in db; relying on SSDP/mDNS for discovery");
      return;
    }
    log.info(`seeding ${rows.length} known device(s) from db`);
    // Insert each as offline immediately so the PWA's first /devices call
    // shows them as known-but-grey. The probe results upgrade them to online.
    for (const r of rows) {
      this.devices.set(r.id.toUpperCase(), {
        deviceId: r.id.toUpperCase(),
        name: r.name,
        type: r.type,
        ip: r.ip,
        mac: r.id.toUpperCase(),
        softwareVersion: r.software_version,
        hasBass: !!r.has_bass,
        hasAux: !!r.has_aux,
        sources: [],
        lastSeen: r.last_seen,
        online: false,
      });
      this.byIp.set(r.ip, r.id.toUpperCase());
    }
    await Promise.allSettled(rows.map((r) => this.adopt(r.ip, "db-seed")));
  }

  /** Periodic retry of every device we believe is offline. Uses the IP we
   * remember (db-backed) so it survives Pi restarts. A speaker that just
   * came back from a power cycle gets re-adopted within 15s. */
  private async retryOffline(): Promise<void> {
    const offline = [...this.devices.values()].filter(d => !d.online);
    if (offline.length === 0) return;
    log.debug(`retryOffline: ${offline.length} candidate(s)`);
    await Promise.allSettled(offline.map((d) => this.adopt(d.ip, "retry")));
  }

  /** Manual rescan endpoint — fires SSDP M-SEARCH immediately and re-probes
   * every known device. Triggered by the PWA's "Rescan" button. */
  async rescan(): Promise<{ knownProbed: number; ssdpFired: boolean }> {
    log.info(`manual rescan requested`);
    let ssdpFired = false;
    try {
      this.ssdp.search();
      ssdpFired = true;
    } catch (e) {
      log.warn("ssdp.search failed", { err: String(e) });
    }
    // Probe every device we know about, online or not — the cheap case (already
    // online and answering on 8090) is a no-op once adopt() sees the existing
    // entry; the worthwhile case (just came back online) gets a fresh probe.
    const all = [...this.devices.values()];
    await Promise.allSettled(all.map((d) => this.adopt(d.ip, "rescan")));
    return { knownProbed: all.length, ssdpFired };
  }
}
