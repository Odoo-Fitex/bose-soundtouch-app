import WebSocket from "ws";
import { logger } from "../log.js";
import { config } from "../config.js";

const log = logger("tunnel");

/**
 * Persistent outbound WebSocket to the Cloudflare Worker. The Worker forwards
 * the PWA's off-LAN HTTP requests over this socket as JSON envelopes; we
 * dispatch them to the local handler and write the JSON response back.
 *
 * Envelope shape:
 *   { id, method, path, headers?, body? } request
 *   { id, status, body }                  response
 */
export type TunnelHandler = (req: TunnelRequest) => Promise<TunnelResponse>;

export interface TunnelRequest {
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface TunnelResponse {
  id: string;
  status: number;
  body: unknown;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private retryMs = 1000;

  constructor(private handler: TunnelHandler) {}

  start() {
    if (!config.workerUrl || !config.householdToken) {
      log.info("tunnel disabled (no SOUNDTIDE_WORKER_URL / SOUNDTIDE_HOUSEHOLD_TOKEN)");
      return;
    }
    this.connect();
  }

  private connect() {
    const url = `${config.workerUrl}?token=${encodeURIComponent(config.householdToken!)}`;
    log.info(`connecting tunnel to ${config.workerUrl}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("tunnel up");
      this.retryMs = 1000;
    });

    ws.on("message", async (raw) => {
      let req: TunnelRequest;
      try { req = JSON.parse(raw.toString()); }
      catch (e) { log.warn("bad tunnel frame", { err: String(e) }); return; }
      try {
        const resp = await this.handler(req);
        ws.send(JSON.stringify(resp));
      } catch (e) {
        ws.send(JSON.stringify({ id: req.id, status: 500, body: { error: String(e) } } satisfies TunnelResponse));
      }
    });

    ws.on("close", () => {
      log.warn("tunnel closed, reconnecting");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => log.warn("tunnel error", { err: err.message }));
  }

  private scheduleReconnect() {
    const delay = Math.min(this.retryMs, 30_000);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }
}
