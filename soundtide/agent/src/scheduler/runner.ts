import cronParser from "cron-parser";
import { logger } from "../log.js";
import { db, type ScheduleRow } from "../db/index.js";

const log = logger("scheduler");

export type FireFn = (s: ScheduleRow) => Promise<void>;

/**
 * Tick once per minute and fire any schedules whose cron expression matches now.
 * Idempotency is per-minute: we track the last fired-minute so a slow tick or a
 * restart at xx:00:30 still fires the 0700 alarm.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickMinute = 0;
  constructor(private fire: FireFn) {}

  start() {
    this.tick();
    // align to the next minute boundary, then run every 60s.
    const ms = 60_000 - (Date.now() % 60_000) + 200;
    setTimeout(() => {
      this.timer = setInterval(() => this.tick(), 60_000);
      this.tick();
    }, ms);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastTickMinute) return;
    this.lastTickMinute = minute;

    const all = db.listSchedules().filter(s => s.enabled);
    for (const s of all) {
      try {
        const it = cronParser.parseExpression(s.cron, { currentDate: new Date(now.getTime() - 30_000) });
        const next = it.next().toDate();
        const dt = next.getTime() - now.getTime();
        if (dt >= -30_000 && dt < 30_000) {
          log.info(`firing schedule ${s.id} (${s.label})`);
          await this.fire(s);
        }
      } catch (e) {
        log.warn(`bad cron in schedule ${s.id}: ${s.cron}`, { err: String(e) });
      }
    }
  }

  /** Compute the next 5 fire times for a cron expression, for the UI. */
  static preview(cron: string, count = 5): Date[] {
    try {
      const it = cronParser.parseExpression(cron);
      return Array.from({ length: count }, () => it.next().toDate());
    } catch { return []; }
  }
}
