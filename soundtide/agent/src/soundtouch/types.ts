// Mirrors the subset of the SoundTouch Web API we actually use.

export type DeviceId = string; // upper-case MAC, e.g. "D05FB8A9591D"

export type PlayState = "PLAY_STATE" | "PAUSE_STATE" | "STOP_STATE" | "BUFFERING_STATE" | "INVALID_PLAY_STATUS";

export interface DeviceInfo {
  deviceId: DeviceId;
  name: string;
  type: string;
  ip: string;
  mac: string;
  softwareVersion: string | null;
  hasBass: boolean;
  hasAux: boolean;
}

export interface ContentItem {
  source: string;
  sourceAccount?: string;
  location?: string;
  itemName?: string;
  isPresetable?: boolean;
}

export interface NowPlaying {
  source: string;
  contentItem: ContentItem | null;
  track: string | null;
  artist: string | null;
  album: string | null;
  stationName: string | null;
  artUrl: string | null;
  artStatus: string | null;
  playStatus: PlayState | null;
  description: string | null;
  stationLocation: string | null;
}

export interface VolumeState {
  target: number;
  actual: number;
  muted: boolean;
}

export interface ZoneState {
  master: DeviceId | null;
  members: { deviceId: DeviceId; ip: string }[];
}

export interface SourceItem {
  source: string;
  sourceAccount: string;
  status: "READY" | "UNAVAILABLE";
  label: string | null;
}

export type Key =
  | "PLAY" | "PAUSE" | "STOP" | "PREV_TRACK" | "NEXT_TRACK"
  | "THUMBS_UP" | "THUMBS_DOWN" | "BOOKMARK" | "POWER" | "MUTE"
  | "VOLUME_UP" | "VOLUME_DOWN"
  | "PRESET_1" | "PRESET_2" | "PRESET_3" | "PRESET_4" | "PRESET_5" | "PRESET_6"
  | "AUX_INPUT" | "SHUFFLE_OFF" | "SHUFFLE_ON" | "REPEAT_OFF" | "REPEAT_ONE" | "REPEAT_ALL"
  | "PLAY_PAUSE" | "ADD_FAVORITE" | "REMOVE_FAVORITE";
