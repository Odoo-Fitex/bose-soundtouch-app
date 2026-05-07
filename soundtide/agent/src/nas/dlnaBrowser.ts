import { Bonjour } from "bonjour-service";
import { XMLParser } from "fast-xml-parser";
import { logger } from "../log.js";

const log = logger("dlna");

export interface DlnaServer {
  uuid: string;
  name: string;
  baseUrl: string;
  controlUrl: string;
}

export interface DlnaItem {
  id: string;
  parentId: string;
  title: string;
  isContainer: boolean;
  url?: string;
  mime?: string;
  artist?: string;
  album?: string;
  duration?: string;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

export class DlnaBrowser {
  private servers = new Map<string, DlnaServer>();

  async start() {
    // Look for any UPnP MediaServer on the LAN. Bonjour is enough for Synology
    // because DSM also advertises a Bonjour name; for plain UPnP-only servers we
    // would rely on the SSDP scanner finding them and being passed in here.
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: "synology" });
    browser.on("up", (svc: any) => log.info(`found synology over bonjour: ${svc.name}`));
    // We additionally accept manual probes via add().
  }

  async add(descriptionUrl: string): Promise<DlnaServer | null> {
    try {
      const res = await fetch(descriptionUrl);
      const txt = await res.text();
      const root = xml.parse(txt) as any;
      const dev = root?.root?.device;
      if (!dev) return null;
      const services: any[] = Array.isArray(dev.serviceList?.service) ? dev.serviceList.service : [dev.serviceList?.service].filter(Boolean);
      const cd = services.find(s => /ContentDirectory/.test(String(s?.serviceType ?? "")));
      if (!cd) return null;
      const base = new URL(descriptionUrl);
      const baseUrl = `${base.protocol}//${base.host}`;
      const controlUrl = new URL(String(cd.controlURL), baseUrl).toString();
      const srv: DlnaServer = {
        uuid: String(dev.UDN ?? "").replace(/^uuid:/, ""),
        name: String(dev.friendlyName ?? "DLNA"),
        baseUrl,
        controlUrl,
      };
      this.servers.set(srv.uuid, srv);
      return srv;
    } catch (e) {
      log.warn("add failed", { url: descriptionUrl, err: String(e) });
      return null;
    }
  }

  list(): DlnaServer[] { return [...this.servers.values()]; }

  async browse(serverUuid: string, objectId: string = "0"): Promise<DlnaItem[]> {
    const srv = this.servers.get(serverUuid);
    if (!srv) throw new Error(`unknown server ${serverUuid}`);
    const body =
      `<?xml version="1.0"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body>` +
      `<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">` +
      `<ObjectID>${escape(objectId)}</ObjectID>` +
      `<BrowseFlag>BrowseDirectChildren</BrowseFlag>` +
      `<Filter>*</Filter>` +
      `<StartingIndex>0</StartingIndex>` +
      `<RequestedCount>200</RequestedCount>` +
      `<SortCriteria></SortCriteria>` +
      `</u:Browse>` +
      `</s:Body>` +
      `</s:Envelope>`;
    const res = await fetch(srv.controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"`,
      },
      body,
    });
    if (!res.ok) throw new Error(`browse ${objectId} → ${res.status}`);
    const env = xml.parse(await res.text()) as any;
    const innerXml = String(env?.["s:Envelope"]?.["s:Body"]?.["u:BrowseResponse"]?.Result ?? "");
    if (!innerXml) return [];
    const didl = xml.parse(innerXml) as any;
    const dl = didl?.["DIDL-Lite"] ?? {};
    const containers = Array.isArray(dl.container) ? dl.container : (dl.container ? [dl.container] : []);
    const items = Array.isArray(dl.item) ? dl.item : (dl.item ? [dl.item] : []);
    const out: DlnaItem[] = [
      ...containers.map((c: any) => ({
        id: String(c["@_id"]),
        parentId: String(c["@_parentID"]),
        title: String(c["dc:title"] ?? c.title ?? ""),
        isContainer: true,
      })),
      ...items.map((it: any) => {
        const ress = Array.isArray(it.res) ? it.res : (it.res ? [it.res] : []);
        const audio = ress.find((r: any) => /audio/i.test(String(r["@_protocolInfo"] ?? ""))) ?? ress[0];
        const proto = String(audio?.["@_protocolInfo"] ?? "");
        const mime = (proto.split(":")[2] ?? "").trim() || undefined;
        return {
          id: String(it["@_id"]),
          parentId: String(it["@_parentID"]),
          title: String(it["dc:title"] ?? it.title ?? ""),
          isContainer: false,
          url: audio ? String(audio["#text"] ?? "") : undefined,
          mime,
          artist: it["dc:creator"] ? String(it["dc:creator"]) : undefined,
          album: it["upnp:album"] ? String(it["upnp:album"]) : undefined,
          duration: audio?.["@_duration"] ? String(audio["@_duration"]) : undefined,
        };
      }),
    ];
    return out;
  }
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
