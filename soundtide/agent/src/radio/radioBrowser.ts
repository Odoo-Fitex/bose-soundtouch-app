import { logger } from "../log.js";

const log = logger("radio");

/**
 * Wrapper around the public radio-browser.info API. Resolves a working host
 * once on startup; falls back to a hard-coded mirror if DNS round-robin fails.
 */

export interface RadioStation {
  uuid: string;
  name: string;
  url: string;       // resolved stream URL
  homepage: string;
  favicon: string;
  country: string;
  language: string;
  tags: string;
  codec: string;
  bitrate: number;
}

const FALLBACK_HOSTS = [
  "de1.api.radio-browser.info",
  "fr1.api.radio-browser.info",
  "nl1.api.radio-browser.info",
];

export class RadioBrowser {
  private host = "all.api.radio-browser.info";
  private cache = new Map<string, { ts: number; data: RadioStation[] }>();

  async chooseHost() {
    for (const h of [this.host, ...FALLBACK_HOSTS]) {
      try {
        const res = await fetch(`https://${h}/json/stats`, { headers: ua() });
        if (res.ok) { this.host = h; log.info(`using radio-browser host ${h}`); return; }
      } catch { /* keep trying */ }
    }
    log.warn(`no radio-browser host responded; staying on ${this.host}`);
  }

  async search(opts: { name?: string; country?: string; tag?: string; limit?: number }): Promise<RadioStation[]> {
    const key = JSON.stringify(opts);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < 60_000) return cached.data;

    const params = new URLSearchParams();
    if (opts.name) params.set("name", opts.name);
    if (opts.country) params.set("country", opts.country);
    if (opts.tag) params.set("tag", opts.tag);
    params.set("limit", String(opts.limit ?? 50));
    params.set("hidebroken", "true");
    params.set("order", "clickcount");
    params.set("reverse", "true");

    const res = await fetch(`https://${this.host}/json/stations/search?${params}`, { headers: ua() });
    if (!res.ok) throw new Error(`radio search ${res.status}`);
    const raw = await res.json() as any[];
    const data: RadioStation[] = raw.map(mapStation);
    this.cache.set(key, { ts: Date.now(), data });
    return data;
  }

  async byUuid(uuid: string): Promise<RadioStation | null> {
    const res = await fetch(`https://${this.host}/json/stations/byuuid?uuids=${uuid}`, { headers: ua() });
    if (!res.ok) return null;
    const arr = await res.json() as any[];
    return arr[0] ? mapStation(arr[0]) : null;
  }

  /** Bump the click counter so the project's stats reflect actual usage. */
  async click(uuid: string) {
    try { await fetch(`https://${this.host}/json/url/${uuid}`, { headers: ua() }); }
    catch (e) { log.debug("click bump failed", { err: String(e) }); }
  }

  guessMime(s: RadioStation): string {
    const codec = s.codec.toLowerCase();
    if (codec.includes("aac")) return "audio/aac";
    if (codec.includes("ogg")) return "audio/ogg";
    if (codec.includes("flac")) return "audio/flac";
    if (codec.includes("mp3") || codec.includes("mpeg")) return "audio/mpeg";
    return "audio/mpeg";
  }
}

function mapStation(r: any): RadioStation {
  return {
    uuid: r.stationuuid,
    name: r.name ?? "",
    url: r.url_resolved || r.url || "",
    homepage: r.homepage ?? "",
    favicon: r.favicon ?? "",
    country: r.country ?? "",
    language: r.language ?? "",
    tags: r.tags ?? "",
    codec: r.codec ?? "",
    bitrate: Number(r.bitrate ?? 0),
  };
}

function ua(): Record<string, string> {
  return { "User-Agent": "SoundTide/0.1 (+https://github.com/your/soundtide)" };
}
