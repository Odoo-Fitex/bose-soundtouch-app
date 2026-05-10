/**
 * Endpoint resolution: if the page is loaded from the LAN agent (any host on a
 * private IP range, or *.local), talk to it directly. Otherwise assume we are
 * loaded from the Cloudflare Worker and prefix every call with /agent.
 */

function isLanHost(hostname: string): boolean {
  if (hostname.endsWith(".local")) return true;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

const lan = isLanHost(window.location.hostname);
const TOKEN_KEY = "soundtide.token";

export const apiBase = lan ? "" : "/agent";
export const wsUrl = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${apiBase}/ws`;
})();

export interface Device {
  deviceId: string;
  name: string;
  type: string;
  ip: string;
  hasBass: boolean;
  hasAux: boolean;
  online: boolean;
  softwareVersion: string | null;
  sources: { source: string; sourceAccount: string; status: string; label: string | null }[];
}
export interface Volume { target: number; actual: number; muted: boolean; }
export interface NowPlaying {
  source: string;
  contentItem: { source: string; sourceAccount?: string; location?: string; itemName?: string } | null;
  track: string | null;
  artist: string | null;
  album: string | null;
  stationName: string | null;
  artUrl: string | null;
  artStatus: string | null;
  playStatus: string | null;
  description: string | null;
  stationLocation: string | null;
}
export interface Zone { master: string | null; members: { deviceId: string; ip: string }[]; }
export interface Preset {
  id: string;
  slot: number | null;
  speaker_id: string | null;
  scene_id: string | null;
  label: string;
  artwork_url: string | null;
  kind: "radio" | "podcast" | "nas" | "aux" | "spotify_uri" | "raw";
  payload: string;
}
export interface Scene {
  id: string;
  label: string;
  master_id: string;
  slave_ids: string;
  default_volume: number | null;
}
export interface Schedule {
  id: string;
  label: string;
  cron: string;
  scene_id: string | null;
  speaker_id: string | null;
  preset_id: string;
  ramp_from: number | null;
  ramp_to: number | null;
  ramp_seconds: number | null;
  enabled: 0 | 1;
}
export interface RadioStation {
  uuid: string;
  name: string;
  url: string;
  homepage: string;
  favicon: string;
  country: string;
  language: string;
  tags: string;
  codec: string;
  bitrate: number;
}

function authHeader(): Record<string, string> {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Only send Content-Type when there's an actual body. Setting it on an empty
  // POST makes Fastify try to parse "" as JSON and 400.
  const headers: Record<string, string> = { ...authHeader() };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${apiBase}${path}`, { method, headers, body: payload });
  if (!res.ok) {
    // Try to surface the server's `error` message instead of a bare status.
    let detail = `${res.status}`;
    try {
      const j = await res.clone().json() as { error?: string };
      if (j?.error) detail = j.error;
    } catch { /* not JSON */ }
    throw new Error(`${method} ${path}: ${detail}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : (await res.text() as unknown as T);
}

export const api = {
  setToken(t: string | null) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
  hasToken: () => !!localStorage.getItem(TOKEN_KEY),

  health: () => req<{ ok: boolean }>("GET", "/health"),

  // devices
  devices: () => req<Device[]>("GET", "/devices"),
  rescan: () => req<{ ok: boolean; knownProbed: number; ssdpFired: boolean; devices: Device[] }>("POST", "/devices/rescan"),
  state: (id: string) => req<{ info: any; volume: Volume; nowPlaying: NowPlaying; zone: Zone }>("GET", `/devices/${id}/state`),
  key: (id: string, key: string) => req<{ ok: boolean }>("POST", `/devices/${id}/key`, { key }),
  volume: (id: string, volume?: number, muted?: boolean) => req<{ ok: boolean }>("POST", `/devices/${id}/volume`, { volume, muted }),
  rename: (id: string, name: string) => req<{ ok: boolean }>("POST", `/devices/${id}/name`, { name }),

  // presets
  presets: (speakerId?: string) => req<Preset[]>("GET", `/presets${speakerId ? `?speakerId=${speakerId}` : ""}`),
  savePreset: (p: Partial<Preset>) => req<Preset>("PUT", "/presets", p),
  deletePreset: (id: string) => req<{ ok: boolean }>("DELETE", `/presets/${id}`),
  playPreset: (id: string, opts: { speakerId?: string; sceneId?: string } = {}) =>
    req<{ ok: boolean }>("POST", `/presets/${id}/play`, opts),

  // ad-hoc zones (live grouping)
  zoneAdd: (masterId: string, slaveId: string) =>
    req<{ ok: boolean }>("POST", `/devices/${masterId}/zone/add`, { slaveId }),
  zoneRemove: (masterId: string, slaveId: string) =>
    req<{ ok: boolean }>("POST", `/devices/${masterId}/zone/remove`, { slaveId }),
  zoneClear: (id: string) => req<{ ok: boolean }>("DELETE", `/devices/${id}/zone`),

  // scenes
  scenes: () => req<Scene[]>("GET", "/scenes"),
  saveScene: (s: Partial<Scene>) => req<Scene>("PUT", "/scenes", s),
  deleteScene: (id: string) => req<{ ok: boolean }>("DELETE", `/scenes/${id}`),
  applyScene: (id: string) => req<{ ok: boolean }>("POST", `/scenes/${id}/apply`),

  // schedules
  schedules: () => req<Schedule[]>("GET", "/schedules"),
  saveSchedule: (s: Partial<Schedule>) => req<Schedule>("PUT", "/schedules", s),
  deleteSchedule: (id: string) => req<{ ok: boolean }>("DELETE", `/schedules/${id}`),
  cronPreview: (cron: string) => req<string[]>("GET", `/schedules/preview?cron=${encodeURIComponent(cron)}`),

  // radio
  radioSearch: (q: { name?: string; country?: string; tag?: string; limit?: number }) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as any);
    return req<RadioStation[]>("GET", `/radio/search?${p.toString()}`);
  },
  radioPlay: (uuid: string, opts: { speakerId?: string; sceneId?: string }) =>
    req<{ ok: boolean }>("POST", "/radio/play", { uuid, ...opts }),

  // nas
  nasServers: () => req<{ uuid: string; name: string; baseUrl: string }[]>("GET", "/nas/servers"),
  nasAdd: (descriptionUrl: string) => req<unknown>("POST", "/nas/add", { descriptionUrl }),
  nasBrowse: (uuid: string, objectId = "0") =>
    req<{ id: string; parentId: string; title: string; isContainer: boolean; url?: string; mime?: string }[]>("GET", `/nas/${uuid}/browse?objectId=${encodeURIComponent(objectId)}`),
  nasPlay: (body: { url: string; mime: string; title: string; speakerId?: string; sceneId?: string }) =>
    req<{ ok: boolean }>("POST", "/nas/play", body),
  nasWake: () => req<{ ok: boolean }>("POST", "/nas/wake"),
};
