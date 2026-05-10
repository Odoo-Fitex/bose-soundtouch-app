import { atom, map } from "nanostores";
import { api, wsUrl, type Device, type NowPlaying, type Volume, type Zone } from "./api.js";

export type Tab = "now" | "presets" | "zones" | "browse" | "schedule" | "settings";
export const $tab = atom<Tab>("now");

export const $devices = atom<Device[]>([]);
export const $selectedSpeaker = atom<string | null>(localStorage.getItem("soundtide.selected"));
export const $now = map<Record<string, NowPlaying>>({});
export const $vol = map<Record<string, Volume>>({});
export const $zones = map<Record<string, Zone>>({});

// Cached artwork keyed by speaker id. Populated when a radio station is
// started (since the SoundTouch reports no useful artUrl for UPnP streams).
// Persists across reloads.
const ART_KEY = "soundtide.cached_art";
const initialArt = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(ART_KEY) ?? "{}") as Record<string, unknown>;
    // Old builds may have stuffed objects (or `[object Object]`) into this
    // map, which then renders as a broken <img> hitting GET /[object Object].
    // Filter to plausible URLs only.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && /^(https?:\/\/|data:|\/)/.test(v)) clean[k] = v;
    }
    return clean;
  } catch { return {} as Record<string, string>; }
})();
export const $cachedArt = map<Record<string, string>>(initialArt);
// Persist any legacy-cleanup we did above, so a stale object never re-poisons
// the next page load.
localStorage.setItem(ART_KEY, JSON.stringify(initialArt));

/** True iff `s` looks like an http(s)/data URL or a same-origin path. */
export function isImageUrl(s: unknown): s is string {
  return typeof s === "string" && /^(https?:\/\/|data:|\/)/.test(s);
}

export function recordArt(speakerId: string, url: string | null | undefined | unknown) {
  if (!isImageUrl(url)) { $cachedArt.setKey(speakerId, ""); }
  else { $cachedArt.setKey(speakerId, url); }
  localStorage.setItem(ART_KEY, JSON.stringify($cachedArt.get()));
}

// Sleep timer: epoch ms when the timer should fire, or null if disabled.
const SLEEP_KEY = "soundtide.sleep_at";
const initialSleep = Number(localStorage.getItem(SLEEP_KEY) ?? "");
export const $sleepAt = atom<number | null>(Number.isFinite(initialSleep) && initialSleep > Date.now() ? initialSleep : null);
$sleepAt.subscribe((v) => {
  if (v) localStorage.setItem(SLEEP_KEY, String(v));
  else localStorage.removeItem(SLEEP_KEY);
});

// Theme: auto follows prefers-color-scheme; light/dark are explicit.
export type Theme = "auto" | "light" | "dark";
export const $theme = atom<Theme>((localStorage.getItem("soundtide.theme") as Theme) || "auto");
$theme.subscribe((v) => {
  localStorage.setItem("soundtide.theme", v);
  applyTheme(v);
});
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", t);
  }
}

$selectedSpeaker.subscribe((v) => {
  if (v) localStorage.setItem("soundtide.selected", v);
  else localStorage.removeItem("soundtide.selected");
});

let ws: WebSocket | null = null;
let retry = 1000;

export async function bootstrap() {
  applyTheme($theme.get());
  await refreshDevices();
  if (!$selectedSpeaker.get() && $devices.get()[0]) $selectedSpeaker.set($devices.get()[0]!.deviceId);
  for (const d of $devices.get()) refreshState(d.deviceId);
  connectWs();
  startSleepTimerWatcher();
}

function startSleepTimerWatcher() {
  // Fires PAUSE on the selected speaker when the deadline elapses.
  setInterval(async () => {
    const at = $sleepAt.get();
    if (!at || Date.now() < at) return;
    $sleepAt.set(null);
    const id = $selectedSpeaker.get();
    if (!id) return;
    try {
      await api.key(id, "PAUSE");
      // After a short grace period, also send POWER so the speaker sleeps.
      setTimeout(() => api.key(id, "POWER").catch(() => undefined), 1500);
    } catch (e) {
      console.warn("sleep timer failed", e);
    }
  }, 5000);
}

export async function refreshDevices() {
  try {
    const list = await api.devices();
    $devices.set(list);
  } catch (e) {
    console.warn("device list failed", e);
  }
}

export async function refreshState(deviceId: string) {
  try {
    const s = await api.state(deviceId);
    $now.setKey(deviceId, s.nowPlaying);
    $vol.setKey(deviceId, s.volume);
    $zones.setKey(deviceId, s.zone);
  } catch (e) {
    console.warn(`state ${deviceId} failed`, e);
  }
}

function connectWs() {
  if (ws) return;
  try {
    const sock = new WebSocket(wsUrl);
    ws = sock;
    sock.addEventListener("open", () => { retry = 1000; });
    sock.addEventListener("message", (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (data.type === "speaker") {
          const ev = data.ev;
          if (ev?.type === "volumeUpdated") refreshState(ev.deviceId);
          if (ev?.type === "nowPlayingUpdated") refreshState(ev.deviceId);
          if (ev?.type === "zoneUpdated") refreshState(ev.deviceId);
        }
        if (data.type === "device:added" || data.type === "device:offline") {
          refreshDevices();
        }
      } catch { /* ignore */ }
    });
    sock.addEventListener("close", () => {
      ws = null;
      const delay = Math.min(retry, 30_000);
      retry = Math.min(retry * 2, 30_000);
      setTimeout(connectWs, delay);
    });
    sock.addEventListener("error", () => sock.close());
  } catch (e) {
    console.warn("ws connect failed", e);
  }
}

// Optimistic helpers used by the UI -----------------------------------------

export async function setVolume(deviceId: string, value: number) {
  $vol.setKey(deviceId, { target: value, actual: value, muted: false });
  await api.volume(deviceId, value);
}
export async function toggleMute(deviceId: string) {
  const current = $vol.get()[deviceId];
  await api.volume(deviceId, undefined, !(current?.muted ?? false));
}
export async function press(deviceId: string, key: string) {
  await api.key(deviceId, key);
}
