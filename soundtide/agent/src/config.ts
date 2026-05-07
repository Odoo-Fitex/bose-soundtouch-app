export const config = {
  httpPort: Number(process.env.SOUNDTIDE_HTTP_PORT ?? 7780),
  upnpPort: Number(process.env.SOUNDTIDE_UPNP_PORT ?? 7790),
  dataDir: process.env.SOUNDTIDE_DATA_DIR ?? "./data",
  logLevel: (process.env.SOUNDTIDE_LOG_LEVEL ?? "info") as
    | "trace" | "debug" | "info" | "warn" | "error",
  nasWolMac: process.env.SOUNDTIDE_NAS_WOL_MAC || null,
  workerUrl: process.env.SOUNDTIDE_WORKER_URL || null,
  householdToken: process.env.SOUNDTIDE_HOUSEHOLD_TOKEN || null,
} as const;

export type Config = typeof config;
