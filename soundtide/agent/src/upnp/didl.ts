/**
 * Tiny helpers to build DIDL-Lite XML — the format UPnP/DLNA browsers expect.
 * We only ever advertise audio items, never images or videos.
 */

export interface DidlItem {
  id: string;                    // unique within the server
  parentId: string;              // "0" for root, otherwise a container id
  title: string;
  upnpClass?: string;            // defaults to object.item.audioItem.musicTrack
  res: { uri: string; protocolInfo: string; duration?: string };
  creator?: string;
  album?: string;
  date?: string;
}

const xmlesc = (s: string) =>
  s.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function didlForItems(items: DidlItem[]): string {
  const inner = items.map((it) => {
    const cls = xmlesc(it.upnpClass ?? "object.item.audioItem.musicTrack");
    const protoInfo = xmlesc(it.res.protocolInfo);
    const uri = xmlesc(it.res.uri);
    const dur = it.res.duration ? ` duration="${xmlesc(it.res.duration)}"` : "";
    const creator = it.creator ? `<dc:creator>${xmlesc(it.creator)}</dc:creator>` : "";
    const album = it.album ? `<upnp:album>${xmlesc(it.album)}</upnp:album>` : "";
    const date = it.date ? `<dc:date>${xmlesc(it.date)}</dc:date>` : "";
    return [
      `<item id="${xmlesc(it.id)}" parentID="${xmlesc(it.parentId)}" restricted="1">`,
      `<dc:title>${xmlesc(it.title)}</dc:title>`,
      `<upnp:class>${cls}</upnp:class>`,
      creator, album, date,
      `<res protocolInfo="${protoInfo}"${dur}>${uri}</res>`,
      `</item>`,
    ].join("");
  }).join("");

  return [
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite"`,
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    ` xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`,
    inner,
    `</DIDL-Lite>`,
  ].join("");
}

/** Audio MIME → DLNA protocolInfo string. */
export function protocolInfoFor(mime: string): string {
  return `http-get:*:${mime}:*`;
}
