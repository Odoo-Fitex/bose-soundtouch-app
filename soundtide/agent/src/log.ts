import { config } from "./config.js";

const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
const threshold = LEVELS.indexOf(config.logLevel);

function fmt(level: Level, scope: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + JSON.stringify(extra);
  return `${ts} [${level.toUpperCase()}] ${scope}: ${msg}${tail}`;
}

export function logger(scope: string) {
  function at(level: Level) {
    return (msg: string, extra?: unknown) => {
      if (LEVELS.indexOf(level) < threshold) return;
      const line = fmt(level, scope, msg, extra);
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    };
  }
  return {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}
