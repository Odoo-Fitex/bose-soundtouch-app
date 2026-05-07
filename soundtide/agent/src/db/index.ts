import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "../config.js";
import { logger } from "../log.js";

const log = logger("db");

export interface PresetRow {
  id: string;
  slot: number | null;            // 1..6 if bound to a hardware preset, else null
  speaker_id: string | null;      // MAC if bound to a single speaker, else null
  scene_id: string | null;        // alternative target
  label: string;
  artwork_url: string | null;
  kind: "radio" | "podcast" | "nas" | "aux" | "spotify_uri" | "raw";
  payload: string;                // JSON
  created_at: number;
  updated_at: number;
}

export interface SceneRow {
  id: string;
  label: string;
  master_id: string;
  slave_ids: string;              // JSON array of MACs
  default_volume: number | null;
  created_at: number;
}

export interface ScheduleRow {
  id: string;
  label: string;
  cron: string;
  scene_id: string | null;
  speaker_id: string | null;
  preset_id: string;
  ramp_from: number | null;
  ramp_to: number | null;
  ramp_seconds: number | null;
  enabled: 1 | 0;
  created_at: number;
}

export interface DeviceRow {
  id: string;            // MAC
  name: string;
  type: string;
  ip: string;
  software_version: string | null;
  has_bass: 1 | 0;
  has_aux: 1 | 0;
  last_seen: number;
}

export class Db {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, "soundtide.sqlite");
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    log.info(`db ready at ${file}`);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        ip TEXT NOT NULL,
        software_version TEXT,
        has_bass INTEGER NOT NULL DEFAULT 0,
        has_aux INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presets (
        id TEXT PRIMARY KEY,
        slot INTEGER,
        speaker_id TEXT,
        scene_id TEXT,
        label TEXT NOT NULL,
        artwork_url TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        master_id TEXT NOT NULL,
        slave_ids TEXT NOT NULL,
        default_volume INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cron TEXT NOT NULL,
        scene_id TEXT,
        speaker_id TEXT,
        preset_id TEXT NOT NULL,
        ramp_from INTEGER,
        ramp_to INTEGER,
        ramp_seconds INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_presets_speaker_slot ON presets(speaker_id, slot);
    `);
  }

  // ---- devices ----
  upsertDevice(d: Omit<DeviceRow, "last_seen"> & { last_seen?: number }) {
    const row: DeviceRow = { ...d, last_seen: d.last_seen ?? Date.now() } as DeviceRow;
    this.db.prepare(`
      INSERT INTO devices (id, name, type, ip, software_version, has_bass, has_aux, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, ip=excluded.ip,
        software_version=excluded.software_version,
        has_bass=excluded.has_bass, has_aux=excluded.has_aux,
        last_seen=excluded.last_seen
    `).run(row.id, row.name, row.type, row.ip, row.software_version, row.has_bass, row.has_aux, row.last_seen);
  }

  listDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY name`).all() as DeviceRow[];
  }

  // ---- presets ----
  listPresets(speakerId?: string): PresetRow[] {
    if (speakerId) {
      return this.db.prepare(`SELECT * FROM presets WHERE speaker_id = ? ORDER BY slot, label`).all(speakerId) as PresetRow[];
    }
    return this.db.prepare(`SELECT * FROM presets ORDER BY label`).all() as PresetRow[];
  }

  getPreset(id: string): PresetRow | undefined {
    return this.db.prepare(`SELECT * FROM presets WHERE id = ?`).get(id) as PresetRow | undefined;
  }

  presetForSlot(speakerId: string, slot: number): PresetRow | undefined {
    return this.db.prepare(`SELECT * FROM presets WHERE speaker_id = ? AND slot = ?`).get(speakerId, slot) as PresetRow | undefined;
  }

  upsertPreset(p: Omit<PresetRow, "id" | "created_at" | "updated_at"> & Partial<Pick<PresetRow, "id">>): PresetRow {
    const id = p.id ?? crypto.randomUUID();
    const now = Date.now();
    const existing = this.db.prepare(`SELECT created_at FROM presets WHERE id = ?`).get(id) as { created_at: number } | undefined;
    // If user is overwriting a slot, free the old occupant.
    if (p.speaker_id && p.slot != null) {
      this.db.prepare(`DELETE FROM presets WHERE speaker_id = ? AND slot = ? AND id != ?`).run(p.speaker_id, p.slot, id);
    }
    this.db.prepare(`
      INSERT INTO presets (id, slot, speaker_id, scene_id, label, artwork_url, kind, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slot=excluded.slot, speaker_id=excluded.speaker_id, scene_id=excluded.scene_id,
        label=excluded.label, artwork_url=excluded.artwork_url, kind=excluded.kind,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run(id, p.slot, p.speaker_id, p.scene_id, p.label, p.artwork_url, p.kind, p.payload, existing?.created_at ?? now, now);
    return this.getPreset(id)!;
  }

  deletePreset(id: string) {
    this.db.prepare(`DELETE FROM presets WHERE id = ?`).run(id);
  }

  // ---- scenes ----
  listScenes(): SceneRow[] {
    return this.db.prepare(`SELECT * FROM scenes ORDER BY label`).all() as SceneRow[];
  }

  getScene(id: string): SceneRow | undefined {
    return this.db.prepare(`SELECT * FROM scenes WHERE id = ?`).get(id) as SceneRow | undefined;
  }

  upsertScene(s: Omit<SceneRow, "id" | "created_at"> & Partial<Pick<SceneRow, "id">>): SceneRow {
    const id = s.id ?? crypto.randomUUID();
    const existing = this.db.prepare(`SELECT created_at FROM scenes WHERE id = ?`).get(id) as { created_at: number } | undefined;
    this.db.prepare(`
      INSERT INTO scenes (id, label, master_id, slave_ids, default_volume, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, master_id=excluded.master_id,
        slave_ids=excluded.slave_ids, default_volume=excluded.default_volume
    `).run(id, s.label, s.master_id, s.slave_ids, s.default_volume, existing?.created_at ?? Date.now());
    return this.getScene(id)!;
  }

  deleteScene(id: string) { this.db.prepare(`DELETE FROM scenes WHERE id = ?`).run(id); }

  // ---- schedules ----
  listSchedules(): ScheduleRow[] {
    return this.db.prepare(`SELECT * FROM schedules ORDER BY label`).all() as ScheduleRow[];
  }

  getSchedule(id: string): ScheduleRow | undefined {
    return this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined;
  }

  upsertSchedule(s: Omit<ScheduleRow, "id" | "created_at"> & Partial<Pick<ScheduleRow, "id">>): ScheduleRow {
    const id = s.id ?? crypto.randomUUID();
    const existing = this.db.prepare(`SELECT created_at FROM schedules WHERE id = ?`).get(id) as { created_at: number } | undefined;
    this.db.prepare(`
      INSERT INTO schedules (id, label, cron, scene_id, speaker_id, preset_id, ramp_from, ramp_to, ramp_seconds, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, cron=excluded.cron, scene_id=excluded.scene_id,
        speaker_id=excluded.speaker_id, preset_id=excluded.preset_id,
        ramp_from=excluded.ramp_from, ramp_to=excluded.ramp_to, ramp_seconds=excluded.ramp_seconds,
        enabled=excluded.enabled
    `).run(id, s.label, s.cron, s.scene_id, s.speaker_id, s.preset_id, s.ramp_from, s.ramp_to, s.ramp_seconds, s.enabled, existing?.created_at ?? Date.now());
    return this.getSchedule(id)!;
  }

  deleteSchedule(id: string) { this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id); }
}

export const db = new Db();
