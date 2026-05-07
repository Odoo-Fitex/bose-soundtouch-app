import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { logger } from "../log.js";

const log = logger("ssdp");

const MULTICAST = "239.255.255.250";
const PORT = 1900;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:MediaRenderer:1";

const M_SEARCH =
  "M-SEARCH * HTTP/1.1\r\n" +
  `HOST: ${MULTICAST}:${PORT}\r\n` +
  'MAN: "ssdp:discover"\r\n' +
  "MX: 2\r\n" +
  `ST: ${SEARCH_TARGET}\r\n\r\n`;

export interface SsdpHit {
  ip: string;
  location: string;
  usn: string;
  st: string;
}

/**
 * Periodic SSDP scanner. Emits 'hit' events for any UPnP MediaRenderer responses,
 * which the upstream registry then filters down to SoundTouch devices.
 */
export class SsdpScanner extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8");
      if (!/HTTP\/1\.1\s+200\s+OK/i.test(text) && !/NOTIFY\s+\*\s+HTTP\/1\.1/i.test(text)) return;
      const headers = parseHeaders(text);
      const st = headers["st"] || headers["nt"] || "";
      if (!/MediaRenderer:1$/i.test(st)) return;
      const hit: SsdpHit = {
        ip: rinfo.address,
        location: headers["location"] ?? "",
        usn: headers["usn"] ?? "",
        st,
      };
      this.emit("hit", hit);
    });
    socket.on("error", (err) => log.warn("socket error", { err: err.message }));
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.setMulticastTTL(2);
      try { socket.addMembership(MULTICAST); } catch (e) { log.debug("addMembership failed", { err: String(e) }); }
      log.info(`scanner bound on ${socket.address().port}`);
      this.search();
      this.timer = setInterval(() => this.search(), 60_000);
    });
    this.socket = socket;
  }

  stop() {
    this.timer && clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  search() {
    if (!this.socket) return;
    const buf = Buffer.from(M_SEARCH);
    this.socket.send(buf, 0, buf.length, PORT, MULTICAST, (err) => {
      if (err) log.warn("send error", { err: err.message });
      else log.debug("M-SEARCH sent");
    });
  }
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}
