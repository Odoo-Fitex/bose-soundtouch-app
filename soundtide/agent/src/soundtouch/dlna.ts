import { logger } from "../log.js";

const log = logger("soundtouch-dlna");

/**
 * Standard DLNA AVTransport client targeting the SoundTouch's UPnP renderer on
 * port 8091. This is the playback path we use after the cloud cut, because
 * /select with source="UPNP" started returning 1005 UNKNOWN_SOURCE_ERROR.
 *
 * Discovery: we GET the device description from a few well-known URLs to find
 * the actual controlURL. Caches per-IP so we only discover once per device.
 */

interface AvtEndpoint {
  url: string; // absolute URL to POST SOAP requests to
}

const cache = new Map<string, AvtEndpoint>();

const DESC_PATHS = [
  "/AVTransport.xml",
  "/aircable/AVTransport.xml",
  "/upnp/AVTransport.xml",
  "/desc/Server.xml",
  "/upnp/desc/Bose_SM2/BO_sm2_idd.xml",
  "/dmr.xml",
];

/** Try to discover the AVTransport controlURL for this speaker. */
async function discover(ip: string): Promise<AvtEndpoint> {
  if (cache.has(ip)) return cache.get(ip)!;
  // Try the known DLNA description paths.
  for (const path of DESC_PATHS) {
    const url = `http://${ip}:8091${path}`;
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) continue;
      const text = await res.text();
      // Pull the AVTransport service block.
      const m = text.match(/<service>[\s\S]*?<serviceType>[^<]*AVTransport[^<]*<\/serviceType>[\s\S]*?<\/service>/i);
      if (!m) continue;
      const ctrl = m[0].match(/<controlURL>([^<]+)<\/controlURL>/i)?.[1];
      if (!ctrl) continue;
      const absolute = ctrl.startsWith("http")
        ? ctrl
        : `http://${ip}:8091${ctrl.startsWith("/") ? "" : "/"}${ctrl}`;
      const ep: AvtEndpoint = { url: absolute };
      cache.set(ip, ep);
      log.info(`discovered AVTransport at ${absolute}`);
      return ep;
    } catch (e) {
      log.debug(`description ${url} probe failed`, { err: String(e) });
    }
  }
  // Fallback to the standard SoundTouch path. If wrong, the SOAP call will fail.
  const fallback: AvtEndpoint = { url: `http://${ip}:8091/AVTransport/Control` };
  cache.set(ip, fallback);
  log.warn(`no description found for ${ip}, using fallback ${fallback.url}`);
  return fallback;
}

const NS_AVT = "urn:schemas-upnp-org:service:AVTransport:1";

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function envelope(action: string, body: string): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`,
    `<s:Body>`,
    `<u:${action} xmlns:u="${NS_AVT}">`,
    body,
    `</u:${action}>`,
    `</s:Body>`,
    `</s:Envelope>`,
  ].join("");
}

async function soap(ip: string, action: string, body: string): Promise<string> {
  const ep = await discover(ip);
  const payload = envelope(action, body);
  log.debug(`SOAP ${action} -> ${ep.url}`, { payload });
  const res = await fetch(ep.url, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPACTION: `"${NS_AVT}#${action}"`,
    },
    body: payload,
  });
  const text = await res.text();
  if (!res.ok || /<s:Fault\b/.test(text)) {
    log.warn(`SOAP ${action} failed`, { status: res.status, response: text.slice(0, 400) });
    throw new Error(`AVTransport ${action} → ${res.status}: ${text.slice(0, 200)}`);
  }
  log.debug(`SOAP ${action} ok`, { status: res.status, response: text.slice(0, 200) });
  return text;
}

/** Build minimal DIDL-Lite metadata for a single audio item. */
function metadataFor(uri: string, title: string, mime: string): string {
  const protoInfo = `http-get:*:${mime}:*`;
  return [
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite"`,
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`,
    `<item id="0" parentID="-1" restricted="1">`,
    `<dc:title>${escape(title)}</dc:title>`,
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>`,
    `<res protocolInfo="${escape(protoInfo)}">${escape(uri)}</res>`,
    `</item>`,
    `</DIDL-Lite>`,
  ].join("");
}

/** Push a stream URL to the speaker and start playback. */
export async function playUrl(ip: string, uri: string, title: string, mime = "audio/mpeg"): Promise<void> {
  const metadata = metadataFor(uri, title, mime);
  const stop = `<InstanceID>0</InstanceID>`;
  // Best-effort stop first so we cleanly transition between sources.
  try { await soap(ip, "Stop", stop); } catch { /* ignore */ }

  await soap(ip, "SetAVTransportURI",
    `<InstanceID>0</InstanceID>` +
    `<CurrentURI>${escape(uri)}</CurrentURI>` +
    `<CurrentURIMetaData>${escape(metadata)}</CurrentURIMetaData>`);

  await soap(ip, "Play",
    `<InstanceID>0</InstanceID>` +
    `<Speed>1</Speed>`);
}

export async function pause(ip: string): Promise<void> {
  await soap(ip, "Pause", `<InstanceID>0</InstanceID>`);
}

export async function stop(ip: string): Promise<void> {
  await soap(ip, "Stop", `<InstanceID>0</InstanceID>`);
}

/** Useful for the `pwa-served from /app/pwa-dist` log style debugging. */
export function clearCache(): void { cache.clear(); }
