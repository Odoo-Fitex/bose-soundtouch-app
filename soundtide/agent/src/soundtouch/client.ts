import { logger } from "../log.js";
import {
  parseInfo, parseNowPlaying, parseSources, parseVolume, parseZone,
  buildContentItem, buildKeyPayload, buildZonePayload,
} from "./parser.js";
import type {
  ContentItem, DeviceInfo, Key, NowPlaying, SourceItem, VolumeState, ZoneState,
} from "./types.js";

const log = logger("soundtouch");

export class SoundTouchClient {
  constructor(public readonly ip: string) {}

  private url(path: string) {
    return `http://${this.ip}:8090${path}`;
  }

  private async get(path: string, timeoutMs = 5000): Promise<string> {
    // Without an AbortSignal, undici's default keep-alive can keep retrying
    // for a very long time on a half-down speaker (we've seen ~120s lockups
    // on a SoundTouch 10 whose Wi-Fi just bounced). Cap at 5s so a discovery
    // probe fails fast and we keep moving.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.url(path), { method: "GET", signal: ac.signal });
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(path: string, body: string): Promise<string> {
    log.debug(`POST ${this.ip}${path}`, { body });
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    });
    const text = await res.text();
    if (!res.ok || /<errors\b/.test(text)) {
      log.warn(`POST ${this.ip}${path} rejected`, { status: res.status, body, response: text });
      throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    log.debug(`POST ${this.ip}${path} ok`, { response: text.slice(0, 80) });
    return text;
  }

  async info(): Promise<DeviceInfo> {
    return parseInfo(await this.get("/info"));
  }

  async volume(): Promise<VolumeState> {
    return parseVolume(await this.get("/volume"));
  }

  async setVolume(v: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    await this.post("/volume", `<volume>${clamped}</volume>`);
  }

  async setMute(muted: boolean): Promise<void> {
    // Toggling mute via the dedicated MUTE key is the official pattern.
    if (muted) await this.key("MUTE");
  }

  async sources(): Promise<SourceItem[]> {
    return parseSources(await this.get("/sources"));
  }

  async zone(): Promise<ZoneState> {
    return parseZone(await this.get("/getZone"));
  }

  async setZone(master: { deviceId: string; ip: string }, slaves: { deviceId: string; ip: string }[]): Promise<void> {
    const payload = buildZonePayload(master.deviceId, [master, ...slaves]);
    await this.post("/setZone", payload);
  }

  async addZoneSlave(master: { deviceId: string }, slave: { deviceId: string; ip: string }): Promise<void> {
    await this.post("/addZoneSlave", buildZonePayload(master.deviceId, [slave]));
  }

  async removeZoneSlave(master: { deviceId: string }, slave: { deviceId: string; ip: string }): Promise<void> {
    await this.post("/removeZoneSlave", buildZonePayload(master.deviceId, [slave]));
  }

  async nowPlaying(): Promise<NowPlaying> {
    return parseNowPlaying(await this.get("/nowPlaying"));
  }

  async select(item: ContentItem): Promise<void> {
    await this.post("/select", buildContentItem(item));
  }

  /**
   * Send a press+release pair, which is what the speakers expect for almost every key.
   */
  async key(k: Key): Promise<void> {
    await this.post("/key", buildKeyPayload(k, "press"));
    await this.post("/key", buildKeyPayload(k, "release"));
  }

  async setName(name: string): Promise<void> {
    const safe = name.replace(/[<>&"]/g, "");
    await this.post("/name", `<name>${safe}</name>`);
  }
}

/**
 * Best-effort capability probe that mixes /info, /capabilities, /bassCapabilities and /sources.
 * Returns an enriched DeviceInfo where the optional flags are filled in.
 */
export async function probeDevice(ip: string): Promise<DeviceInfo & { sources: SourceItem[] }> {
  const c = new SoundTouchClient(ip);
  const info = await c.info();

  let hasBass = false;
  try {
    const xml = await c["get"]("/bassCapabilities");
    hasBass = /<bassAvailable>\s*true\s*<\/bassAvailable>/i.test(xml);
  } catch (e) {
    log.debug(`bassCapabilities probe failed for ${ip}`, { err: String(e) });
  }

  let sources: SourceItem[] = [];
  try {
    sources = await c.sources();
  } catch (e) {
    log.debug(`sources probe failed for ${ip}`, { err: String(e) });
  }

  const hasAux = sources.some(s => s.source === "AUX") || /SoundTouch (20|30)/i.test(info.type);

  return { ...info, ip, hasBass, hasAux, sources };
}
