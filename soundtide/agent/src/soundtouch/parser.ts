import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type {
  ContentItem, DeviceInfo, NowPlaying, PlayState, SourceItem, VolumeState, ZoneState,
} from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: false,
});

export function parseXml<T = unknown>(xml: string): T {
  return parser.parse(xml) as T;
}

export function buildXml(obj: unknown): string {
  return builder.build(obj);
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function s(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && "#text" in (v as object)) return String((v as { "#text": unknown })["#text"]);
  return String(v);
}

export function parseInfo(xml: string): DeviceInfo {
  const o = parseXml<{ info: any }>(xml).info;
  const deviceId = String(o["@_deviceID"] ?? "").toUpperCase();
  const name = String(o.name ?? "");
  const type = String(o.type ?? "");
  const components = asArray(o.components?.component);
  const swComp = components.find((c: any) => /SCM|PSOC|MAIN|HMI/i.test(String(c.componentCategory ?? ""))) ?? components[0];
  const softwareVersion = swComp ? String(swComp.softwareVersion ?? "") : null;
  const networkInfos = asArray(o.networkInfo);
  const ni = networkInfos[0];
  const ip = ni ? String(ni.ipAddress ?? "") : "";
  const mac = ni ? String(ni.macAddress ?? "").toUpperCase() : deviceId;
  // /info doesn't directly tell us about bass/aux capability — leave the optional flags up to the
  // caller, who will follow up with /capabilities and /sources.
  return { deviceId, name, type, ip, mac, softwareVersion,
    hasBass: false, hasAux: /SoundTouch (20|30)/i.test(type) };
}

export function parseVolume(xml: string): VolumeState {
  const o = parseXml<{ volume: any }>(xml).volume;
  return {
    target: Number(o.targetvolume ?? 0),
    actual: Number(o.actualvolume ?? 0),
    muted: String(o.muteenabled ?? "false") === "true",
  };
}

export function parseSources(xml: string): SourceItem[] {
  const o = parseXml<{ sources: any }>(xml).sources;
  return asArray(o.sourceItem).map((it: any) => ({
    source: String(it["@_source"] ?? ""),
    sourceAccount: String(it["@_sourceAccount"] ?? ""),
    status: (String(it["@_status"] ?? "UNAVAILABLE") as "READY" | "UNAVAILABLE"),
    label: s(it["#text"]),
  })).filter(s => s.source);
}

export function parseZone(xml: string): ZoneState {
  const o = parseXml<{ zone: any }>(xml).zone;
  if (!o) return { master: null, members: [] };
  const master = String(o["@_master"] ?? "").toUpperCase() || null;
  const members = asArray(o.member).map((m: any) => ({
    deviceId: String(s(m) ?? "").toUpperCase(),
    ip: String(m["@_ipaddress"] ?? ""),
  })).filter(m => m.deviceId);
  return { master, members };
}

export function parseNowPlaying(xml: string): NowPlaying {
  const o = parseXml<{ nowPlaying: any }>(xml).nowPlaying;
  const ci = o.ContentItem;
  const contentItem: ContentItem | null = ci ? {
    source: String(ci["@_source"] ?? ""),
    sourceAccount: ci["@_sourceAccount"] ? String(ci["@_sourceAccount"]) : undefined,
    location: ci["@_location"] ? String(ci["@_location"]) : undefined,
    isPresetable: ci["@_isPresetable"] ? String(ci["@_isPresetable"]) === "true" : undefined,
    itemName: s(ci.itemName) ?? undefined,
  } : null;
  const art = o.art;
  return {
    source: String(o["@_source"] ?? ""),
    contentItem,
    track: s(o.track),
    artist: s(o.artist),
    album: s(o.album),
    stationName: s(o.stationName),
    artUrl: s(art),
    artStatus: art ? String(art["@_artImageStatus"] ?? "") : null,
    playStatus: (s(o.playStatus) as PlayState | null),
    description: s(o.description),
    stationLocation: s(o.stationLocation),
  };
}

export function buildContentItem(ci: ContentItem): string {
  const attrs: Record<string, string> = { "@_source": ci.source };
  if (ci.sourceAccount) attrs["@_sourceAccount"] = ci.sourceAccount;
  if (ci.location) attrs["@_location"] = ci.location;
  if (ci.isPresetable !== undefined) attrs["@_isPresetable"] = String(ci.isPresetable);
  return buildXml({
    ContentItem: { ...attrs, itemName: ci.itemName ?? "" },
  });
}

export function buildKeyPayload(key: string, state: "press" | "release"): string {
  return buildXml({
    key: { "@_state": state, "@_sender": "SoundTide", "#text": key },
  });
}

export function buildZonePayload(master: string, members: { deviceId: string; ip: string }[]): string {
  return buildXml({
    zone: {
      "@_master": master,
      member: members.map((m) => ({ "@_ipaddress": m.ip, "#text": m.deviceId })),
    },
  });
}
