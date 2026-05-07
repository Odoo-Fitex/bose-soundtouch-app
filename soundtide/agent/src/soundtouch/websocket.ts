import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { logger } from "../log.js";
import { parseXml } from "./parser.js";

const log = logger("soundtouch-ws");

export type SpeakerEvent =
  | { type: "volumeUpdated"; deviceId: string }
  | { type: "nowPlayingUpdated"; deviceId: string }
  | { type: "zoneUpdated"; deviceId: string }
  | { type: "presetsUpdated"; deviceId: string }
  | { type: "infoUpdated"; deviceId: string }
  | { type: "connectionStateUpdated"; deviceId: string }
  | { type: "sourcesUpdated"; deviceId: string }
  | { type: "nowSelectionUpdated"; deviceId: string; presetId: number | null };

/**
 * Maintains a single WebSocket connection (subprotocol "gabbo") to one speaker.
 * Reconnects with exponential backoff. Emits typed SpeakerEvents.
 */
export class SoundTouchWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;

  constructor(public readonly ip: string, public readonly deviceId: string) {
    super();
  }

  start(): void {
    if (this.closed) return;
    const url = `ws://${this.ip}:8080`;
    log.debug(`connecting ${url} for ${this.deviceId}`);
    const ws = new WebSocket(url, "gabbo", { perMessageDeflate: false });
    this.ws = ws;

    ws.on("open", () => {
      log.info(`watcher open ${this.deviceId}@${this.ip}`);
      this.retryMs = 1000;
    });

    ws.on("message", (raw) => {
      const xml = raw.toString();
      try {
        this.dispatch(xml);
      } catch (e) {
        log.warn(`parse error from ${this.deviceId}`, { err: String(e), xml: xml.slice(0, 200) });
      }
    });

    ws.on("close", () => {
      log.debug(`watcher close ${this.deviceId}`);
      if (!this.closed) {
        const delay = Math.min(this.retryMs, 30_000);
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
        setTimeout(() => this.start(), delay);
      }
    });

    ws.on("error", (err) => {
      log.debug(`watcher error ${this.deviceId}: ${err.message}`);
    });
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  private dispatch(xml: string): void {
    const o = parseXml<{ updates: any }>(xml).updates;
    if (!o) return;
    if ("volumeUpdated" in o) this.emit("event", { type: "volumeUpdated", deviceId: this.deviceId });
    if ("nowPlayingUpdated" in o) this.emit("event", { type: "nowPlayingUpdated", deviceId: this.deviceId });
    if ("zoneUpdated" in o) this.emit("event", { type: "zoneUpdated", deviceId: this.deviceId });
    if ("presetsUpdated" in o) this.emit("event", { type: "presetsUpdated", deviceId: this.deviceId });
    if ("infoUpdated" in o) this.emit("event", { type: "infoUpdated", deviceId: this.deviceId });
    if ("connectionStateUpdated" in o) this.emit("event", { type: "connectionStateUpdated", deviceId: this.deviceId });
    if ("sourcesUpdated" in o) this.emit("event", { type: "sourcesUpdated", deviceId: this.deviceId });
    if ("nowSelectionUpdated" in o) {
      const preset = o.nowSelectionUpdated?.preset;
      const id = preset ? Number(preset["@_id"]) : null;
      this.emit("event", { type: "nowSelectionUpdated", deviceId: this.deviceId, presetId: Number.isFinite(id) ? id : null });
    }
  }
}
