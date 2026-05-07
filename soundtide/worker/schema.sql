-- D1 schema mirrors the Pi's SQLite tables so presets/scenes/schedules survive
-- the loss of the Pi (e.g. SD card death). The Pi pushes deltas; the PWA reads
-- here only when the LAN agent is unreachable.

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_presets_household ON presets(household_id);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  label TEXT NOT NULL,
  master_id TEXT NOT NULL,
  slave_ids TEXT NOT NULL,
  default_volume INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_household ON scenes(household_id);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_schedules_household ON schedules(household_id);

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
