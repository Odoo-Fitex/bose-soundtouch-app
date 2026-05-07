import { Bonjour } from "bonjour-service";
import { EventEmitter } from "node:events";
import { logger } from "../log.js";

const log = logger("mdns");

export interface MdnsHit {
  ip: string;
  name: string;
  port: number;
  type: "soundtouch" | "raop";
}

export class MdnsScanner extends EventEmitter {
  private bonjour: Bonjour | null = null;

  start() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    this.subscribe("soundtouch");
    this.subscribe("raop");
    log.info("mdns browser running");
  }

  stop() {
    this.bonjour?.destroy();
    this.bonjour = null;
  }

  private subscribe(type: "soundtouch" | "raop") {
    if (!this.bonjour) return;
    const browser = this.bonjour.find({ type });
    browser.on("up", (svc: any) => {
      const ip = (svc.addresses || []).find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? "";
      if (!ip) return;
      const hit: MdnsHit = { ip, name: String(svc.name ?? ""), port: Number(svc.port ?? 0), type };
      this.emit("hit", hit);
    });
  }
}
