import { atom, map } from "nanostores";
import { api, wsUrl, type Device, type NowPlaying, type Volume, type Zone } from "./api.js";

export type Tab = "now" | "presets" | "zones" | "browse" | "schedule" | "settings";
export const $tab = atom<Tab>("now");

export const $devices = atom<Device[]>([]);
export const $selectedSpeaker = atom<string | null>(localStorage.getItem("soundtide.selected"));
export const $now = map<Record<string, NowPlaying>>({});
export const $vol = map<Record<string, Volume>>({});
export const $zones = map<Record<string, Zone>>({});

$selectedSpeaker.subscribe((v) => {
  if (v) localStorage.setItem("soundtide.selected", v);
  else localStorage.removeItem("soundtide.selected");
});

let ws: WebSocket | null = null;
let retry = 1000;

export async function bootstrap() {
  await refreshDevices();
  if (!$selectedSpeaker.get() && $devices.get()[0]) $selectedSpeaker.set($devices.get()[0]!.deviceId);
  for (const d of $devices.get()) refreshState(d.deviceId);
  connectWs();
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
