/**
 * A minimal UPnP MediaServer that the SoundTouch can discover via SSDP and fetch
 * audio streams from. We keep an in-memory map of "tracks" (radio stations and
 * podcast episodes); incoming HTTP GETs to /stream/<id> are answered with a 302
 * redirect to the upstream URL.
 *
 * The speakers are happy with this because:
 *   - we advertise ourselves as MediaServer:1 over SSDP on the same multicast
 *     group used to find them;
 *   - they fetch the asset with a plain HTTP GET, which returns a 302;
 *   - their HTTP client follows redirects to the underlying TuneIn / podcast
 *     stream and starts decoding.
 *
 * This whole file replaces what the design doc describes as "Gerbera in a
 * sidecar container".
 */

import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream";
import { logger } from "../log.js";
import { didlForItems, protocolInfoFor, type DidlItem } from "./didl.js";

const log = logger("upnp-ms");

const NS_DEVICE = "urn:schemas-upnp-org:device:MediaServer:1";
const NS_CONTENT = "urn:schemas-upnp-org:service:ContentDirectory:1";
const NS_CONNMGR = "urn:schemas-upnp-org:service:ConnectionManager:1";
const SSDP_GROUP = "239.255.255.250";
const SSDP_PORT = 1900;

export interface VirtualTrack {
  id: string;            // stable id, e.g. "r/<station-uuid>" or "p/<episode-id>"
  title: string;
  upstreamUrl: string;   // the actual stream URL (TuneIn / podcast / NAS)
  mime: string;          // audio/mpeg, audio/aac, audio/x-wav, etc.
  creator?: string;
  album?: string;
}

/**
 * Optional resolver invoked when a /stream/<id> request arrives for a track
 * we don't know about (e.g. after an agent restart that wiped in-memory
 * state). Returning a VirtualTrack republishes it on the fly so saved
 * presets survive restarts. Returning null falls through to a 404.
 */
export type LazyResolver = (id: string) => Promise<VirtualTrack | null>;

export class EmbeddedMediaServer {
  private uuid: string;
  private tracks = new Map<string, VirtualTrack>();
  private server: http.Server | null = null;
  private ssdp: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private lazyResolver: LazyResolver | null = null;

  constructor(public port: number, uuid?: string) {
    this.uuid = uuid ?? crypto.randomUUID();
  }

  /** Wire up a function that re-publishes tracks on demand for unknown ids. */
  setLazyResolver(fn: LazyResolver | null) { this.lazyResolver = fn; }

  start() {
    this.startHttp();
    this.startSsdp();
  }

  stop() {
    this.server?.close();
    this.ssdp?.close();
    if (this.announceTimer) clearInterval(this.announceTimer);
  }

  /** Register or overwrite a virtual track. Returns the URL the speaker should fetch. */
  publish(t: VirtualTrack): string {
    this.tracks.set(t.id, t);
    return this.streamUrl(t.id);
  }

  unpublish(id: string) { this.tracks.delete(id); }

  has(id: string) { return this.tracks.has(id); }

  list(): VirtualTrack[] { return [...this.tracks.values()]; }

  /** Where on this machine the speaker will fetch the stream. */
  streamUrl(id: string): string {
    return `http://${this.bestIp()}:${this.port}/stream/${encodeURIComponent(id)}`;
  }

  /** ContentItem location string suitable for /select on a SoundTouch. */
  contentItemLocation(id: string): string {
    return this.streamUrl(id);
  }

  // ---- HTTP -----------------------------------------------------------------

  private startHttp() {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/description.xml") {
        res.setHeader("Content-Type", "text/xml; charset=utf-8");
        res.end(this.deviceDescription());
        return;
      }
      if (req.method === "GET" && url === "/cd.xml") {
        res.setHeader("Content-Type", "text/xml; charset=utf-8");
        res.end(this.contentDirectoryDescription());
        return;
      }
      if (req.method === "GET" && url === "/cm.xml") {
        res.setHeader("Content-Type", "text/xml; charset=utf-8");
        res.end(this.connectionManagerDescription());
        return;
      }
      if (req.method === "POST" && url === "/cd/control") {
        this.handleSoap(req, res);
        return;
      }
      if (req.method === "GET" && url.startsWith("/stream/")) {
        const id = decodeURIComponent(url.slice("/stream/".length));
        // Lazy-resolve unknown ids so saved presets survive agent restarts.
        // The resolver looks the id up against radio-browser etc and (if
        // successful) re-publishes the track for future requests.
        const ensureTrack = async (): Promise<VirtualTrack | null> => {
          const cached = this.tracks.get(id);
          if (cached) return cached;
          if (!this.lazyResolver) return null;
          try {
            const fresh = await this.lazyResolver(id);
            if (fresh) {
              this.tracks.set(fresh.id, fresh);
              log.info(`lazily registered stream ${id}`);
              return fresh;
            }
          } catch (e) {
            log.warn(`lazy resolve ${id} failed`, { err: String(e) });
          }
          return null;
        };
        ensureTrack().then((t) => {
          if (!t) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          this.proxyStream(t.upstreamUrl, t.mime, req, res, 5).catch(err => {
            log.warn(`stream proxy ${id} failed`, { err: String(err) });
            if (!res.headersSent) {
              res.statusCode = 502;
              res.end("upstream error");
            }
          });
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(this.port, () => {
      log.info(`media server http listening on ${this.bestIp()}:${this.port}`);
    });
    this.server = server;
  }

  private handleSoap(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const action = String(req.headers["soapaction"] ?? "").replace(/^"|"$/g, "");
      // We answer Browse with a flat container of every track. Good enough for the SoundTouch,
      // which doesn't actually browse this server before playing — the /select XML tells it
      // exactly which URL to fetch.
      if (action.endsWith("#Browse")) {
        const items: DidlItem[] = [...this.tracks.values()].map((t) => ({
          id: t.id,
          parentId: "0",
          title: t.title,
          creator: t.creator,
          album: t.album,
          res: { uri: this.streamUrl(t.id), protocolInfo: protocolInfoFor(t.mime) },
        }));
        const didl = didlForItems(items);
        const env =
          `<?xml version="1.0" encoding="utf-8"?>` +
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
          `<s:Body>` +
          `<u:BrowseResponse xmlns:u="${NS_CONTENT}">` +
          `<Result>${escapeXml(didl)}</Result>` +
          `<NumberReturned>${items.length}</NumberReturned>` +
          `<TotalMatches>${items.length}</TotalMatches>` +
          `<UpdateID>1</UpdateID>` +
          `</u:BrowseResponse>` +
          `</s:Body>` +
          `</s:Envelope>`;
        res.setHeader("Content-Type", "text/xml; charset=utf-8");
        res.end(env);
        return;
      }
      res.statusCode = 401;
      res.end();
    });
  }

  // ---- SSDP -----------------------------------------------------------------

  private startSsdp() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (!/M-SEARCH/.test(text)) return;
      const want = (text.match(/ST:\s*(\S+)/i) ?? [])[1] ?? "";
      const replyTargets = [
        NS_DEVICE,
        "upnp:rootdevice",
        `uuid:${this.uuid}`,
        NS_CONTENT,
        NS_CONNMGR,
      ];
      const matches = replyTargets.filter(t => want === "ssdp:all" || t === want);
      for (const target of matches) {
        const reply = this.searchReply(target);
        sock.send(reply, 0, reply.length, rinfo.port, rinfo.address);
      }
    });
    sock.bind(SSDP_PORT, () => {
      try { sock.addMembership(SSDP_GROUP); } catch (e) { log.debug("ssdp addMembership failed", { err: String(e) }); }
      this.announce("alive");
      this.announceTimer = setInterval(() => this.announce("alive"), 60_000 * 25);
    });
    this.ssdp = sock;
  }

  private announce(kind: "alive" | "byebye") {
    if (!this.ssdp) return;
    const targets = [
      "upnp:rootdevice",
      `uuid:${this.uuid}`,
      NS_DEVICE,
      NS_CONTENT,
      NS_CONNMGR,
    ];
    for (const t of targets) {
      const usn = t.startsWith("uuid:") ? `uuid:${this.uuid}` : `uuid:${this.uuid}::${t}`;
      const lines = [
        "NOTIFY * HTTP/1.1",
        `HOST: ${SSDP_GROUP}:${SSDP_PORT}`,
        `CACHE-CONTROL: max-age=1800`,
        `LOCATION: http://${this.bestIp()}:${this.port}/description.xml`,
        `NT: ${t}`,
        `NTS: ssdp:${kind}`,
        `SERVER: SoundTide/0.1 UPnP/1.1`,
        `USN: ${usn}`,
        "", "",
      ];
      const buf = Buffer.from(lines.join("\r\n"));
      this.ssdp.send(buf, 0, buf.length, SSDP_PORT, SSDP_GROUP);
    }
  }

  private searchReply(target: string): Buffer {
    const usn = target.startsWith("uuid:") ? `uuid:${this.uuid}` : `uuid:${this.uuid}::${target}`;
    const lines = [
      "HTTP/1.1 200 OK",
      `CACHE-CONTROL: max-age=1800`,
      `EXT: `,
      `LOCATION: http://${this.bestIp()}:${this.port}/description.xml`,
      `SERVER: SoundTide/0.1 UPnP/1.1`,
      `ST: ${target}`,
      `USN: ${usn}`,
      "", "",
    ];
    return Buffer.from(lines.join("\r\n"));
  }

  // ---- XML descriptions -----------------------------------------------------

  private deviceDescription(): string {
    return [
      `<?xml version="1.0"?>`,
      `<root xmlns="urn:schemas-upnp-org:device-1-0">`,
      `<specVersion><major>1</major><minor>0</minor></specVersion>`,
      `<URLBase>http://${this.bestIp()}:${this.port}/</URLBase>`,
      `<device>`,
      `<deviceType>${NS_DEVICE}</deviceType>`,
      `<friendlyName>SoundTide Library</friendlyName>`,
      `<manufacturer>SoundTide</manufacturer>`,
      `<modelName>SoundTide MediaServer</modelName>`,
      `<UDN>uuid:${this.uuid}</UDN>`,
      `<serviceList>`,
      `<service><serviceType>${NS_CONTENT}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/cd.xml</SCPDURL><controlURL>/cd/control</controlURL><eventSubURL>/cd/event</eventSubURL></service>`,
      `<service><serviceType>${NS_CONNMGR}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/cm.xml</SCPDURL><controlURL>/cm/control</controlURL><eventSubURL>/cm/event</eventSubURL></service>`,
      `</serviceList>`,
      `</device>`,
      `</root>`,
    ].join("");
  }

  private contentDirectoryDescription(): string {
    return [
      `<?xml version="1.0"?>`,
      `<scpd xmlns="urn:schemas-upnp-org:service-1-0">`,
      `<specVersion><major>1</major><minor>0</minor></specVersion>`,
      `<actionList>`,
      `<action><name>Browse</name><argumentList>`,
      `<argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>`,
      `<argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>`,
      `<argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>`,
      `<argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>`,
      `<argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>`,
      `<argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>`,
      `<argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>`,
      `<argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>`,
      `<argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>`,
      `<argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>`,
      `</argumentList></action>`,
      `</actionList>`,
      `<serviceStateTable>`,
      ...["ObjectID", "BrowseFlag", "Filter", "SortCriteria", "Result"].map(n =>
        `<stateVariable sendEvents="no"><name>A_ARG_TYPE_${n}</name><dataType>string</dataType></stateVariable>`),
      `<stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>`,
      `<stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>`,
      `<stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>`,
      `</serviceStateTable>`,
      `</scpd>`,
    ].join("");
  }

  private connectionManagerDescription(): string {
    return [
      `<?xml version="1.0"?>`,
      `<scpd xmlns="urn:schemas-upnp-org:service-1-0">`,
      `<specVersion><major>1</major><minor>0</minor></specVersion>`,
      `<actionList></actionList>`,
      `<serviceStateTable></serviceStateTable>`,
      `</scpd>`,
    ].join("");
  }

  // ---- upstream proxy -------------------------------------------------------

  /**
   * Pipe the upstream URL's bytes back to the requesting client, following any
   * redirects ourselves. Handles both http: and https: upstreams, exposes only
   * plain http to the speaker.
   */
  private async proxyStream(
    upstream: string,
    fallbackMime: string,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    maxRedirects: number,
  ): Promise<void> {
    let target = upstream;
    let hops = 0;
    while (hops <= maxRedirects) {
      const u = new URL(target);
      const lib = u.protocol === "https:" ? https : http;
      const upstreamRes = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const upReq = lib.request({
          method: "GET",
          host: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          headers: {
            "User-Agent": "SoundTide/0.1 (UPnP MediaServer)",
            "Icy-MetaData": "0",                   // no shoutcast metadata frames
            "Accept": "*/*",
            ...(clientReq.headers.range ? { Range: String(clientReq.headers.range) } : {}),
          },
        }, (r) => resolve(r));
        upReq.on("error", reject);
        upReq.end();
      });

      const status = upstreamRes.statusCode ?? 0;
      // Follow 3xx redirects ourselves so the speaker only ever sees a 200.
      if (status >= 300 && status < 400 && upstreamRes.headers.location) {
        target = new URL(upstreamRes.headers.location, target).toString();
        upstreamRes.resume(); // discard body
        hops++;
        continue;
      }
      if (status < 200 || status >= 300) {
        upstreamRes.resume();
        clientRes.statusCode = status || 502;
        clientRes.end();
        return;
      }

      // Forward the upstream response to the speaker as-is.
      const ct = (upstreamRes.headers["content-type"] as string | undefined) || fallbackMime;
      clientRes.statusCode = 200;
      clientRes.setHeader("Content-Type", ct);
      // Streaming radio doesn't tell us a length; that's fine, just stream.
      const cl = upstreamRes.headers["content-length"];
      if (cl) clientRes.setHeader("Content-Length", String(cl));
      // Defensive: some embedded renderers care about Connection: close.
      clientRes.setHeader("Connection", "close");

      // pipeline() handles errors on either side without crashing the process.
      // The speaker dropping its TCP connection mid-stream (Stop, source
      // change) is the common case and triggers ERR_STREAM_PREMATURE_CLOSE —
      // we intentionally swallow that one.
      pipeline(upstreamRes, clientRes, (err) => {
        if (!err) return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET") {
          log.debug(`stream proxy closed early (${code})`);
        } else {
          log.warn(`stream proxy pipeline error`, { err: err.message });
        }
        upstreamRes.destroy();
      });
      // If the client (speaker) disconnects, stop pulling from upstream.
      clientReq.on("close", () => upstreamRes.destroy());
      return;
    }
    log.warn(`stream proxy gave up after ${maxRedirects} redirects`, { upstream });
    clientRes.statusCode = 508;
    clientRes.end();
  }

  // ---- helpers --------------------------------------------------------------

  private bestIp(): string {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const n of list ?? []) {
        if (n.family === "IPv4" && !n.internal) return n.address;
      }
    }
    return "127.0.0.1";
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
