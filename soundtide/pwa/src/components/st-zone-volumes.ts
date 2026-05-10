import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $vol, $zones, setVolume, refreshState } from "../store.js";
import type { Device, Volume, Zone } from "../api.js";

/**
 * Master + per-member volume sliders for the zone the selected speaker is in.
 * The master slider scales every member proportionally, preserving relative
 * balance — Sonos's golden pattern.
 *
 * If the selected speaker is not in a zone, this component renders a single
 * volume slider so it can be reused as the only volume widget on Now Playing.
 */
@customElement("st-zone-volumes")
export class StZoneVolumes extends LitElement {
  static properties = { speakerId: { type: String, attribute: "speaker-id" } };
  speakerId: string | null = null;

  @state() private devices: Device[] = [];
  @state() private vol: Record<string, Volume> = {};
  @state() private zones: Record<string, Zone> = {};

  static styles = css`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .name { flex: 1; }
    .pct { width: 40px; text-align: right; color: var(--fg-muted); font-variant-numeric: tabular-nums; font-size: 12px; }
    input[type="range"] { flex: 1; accent-color: var(--accent); }
    .master { font-weight: 600; }
    .divider { height: 1px; background: var(--border); margin: 4px 0; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 999px; background: var(--accent-strong); color: var(--fg); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($vol.subscribe(v => { this.vol = { ...v }; }));
    this.unsub.push($zones.subscribe(v => { this.zones = { ...v }; }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  /** Members of the zone the speaker is in (master first), or just this
   * speaker if standalone.
   *
   * The store keeps one zone view per speaker, and they can disagree
   * transiently: the master sees [A, B, C] while a slave that hasn't
   * processed its zoneUpdated event yet still sees [A, B]. Iterating the
   * map and breaking on the first match is order-dependent and produced
   * "Group volume — 2 speakers" with the third slider missing. Pick the
   * canonical view: prefer the zone keyed by its own master, with the
   * longest member list as the tiebreaker. */
  private members(): { device: Device; role: "master" | "member" | "solo" }[] {
    if (!this.speakerId) return [];
    const me = this.devices.find(d => d.deviceId === this.speakerId);
    if (!me) return [];

    const wantId = this.speakerId.toUpperCase();
    const candidates = Object.entries(this.zones)
      .filter(([, z]) => z?.master)
      .filter(([, z]) => {
        const ids = [z.master!, ...z.members.map(m => m.deviceId)].map(s => s.toUpperCase());
        return ids.includes(wantId);
      });
    if (candidates.length === 0) return [{ device: me, role: "solo" }];

    candidates.sort(([keyA, a], [keyB, b]) => {
      const aIsMaster = keyA.toUpperCase() === a.master!.toUpperCase();
      const bIsMaster = keyB.toUpperCase() === b.master!.toUpperCase();
      if (aIsMaster !== bIsMaster) return aIsMaster ? -1 : 1;
      return b.members.length - a.members.length;
    });
    const [, z] = candidates[0]!;
    const masterId = z.master!;
    const memberIds = z.members
      .map(m => m.deviceId)
      .filter(id => id.toUpperCase() !== masterId.toUpperCase());

    const masterDev = this.devices.find(d => d.deviceId.toUpperCase() === masterId.toUpperCase());
    if (!masterDev) return [{ device: me, role: "solo" }];
    const memberDevs = memberIds
      .map(id => this.devices.find(d => d.deviceId.toUpperCase() === id.toUpperCase()))
      .filter((d): d is Device => !!d);

    return [
      { device: masterDev, role: "master" as const },
      ...memberDevs.map(d => ({ device: d, role: "member" as const })),
    ];
  }

  private setMember(deviceId: string, value: number) {
    setVolume(deviceId, value);
  }

  private setMaster(value: number) {
    const ms = this.members();
    if (ms.length === 0) return;
    // Use the master's current volume as the reference; scale all members
    // proportionally toward the new value.
    const masterDev = ms[0]!.device;
    const cur = this.vol[masterDev.deviceId]?.actual ?? 0;
    const ratio = cur === 0 ? 1 : value / cur;
    for (const { device } of ms) {
      const v = this.vol[device.deviceId]?.actual ?? cur;
      const next = cur === 0 ? value : Math.max(0, Math.min(100, Math.round(v * ratio)));
      setVolume(device.deviceId, next);
    }
    // Refresh after the dust settles to reconcile rounding drift.
    setTimeout(() => ms.forEach(m => refreshState(m.device.deviceId)), 600);
  }

  render() {
    const ms = this.members();
    if (ms.length === 0) return html``;

    // Solo mode: just the speaker's own slider.
    if (ms.length === 1 && ms[0]!.role === "solo") {
      const d = ms[0]!.device;
      const v = this.vol[d.deviceId];
      return html`
        <div class="card">
          <div class="row">
            <span class="name">Volume</span>
            <span class="pct">${v?.actual ?? 0}%</span>
          </div>
          <input type="range" min="0" max="100" .value=${String(v?.actual ?? 0)}
                 @input=${(e: Event) => this.setMember(d.deviceId, Number((e.target as HTMLInputElement).value))} />
        </div>
      `;
    }

    // Zone mode: master slider + per-member.
    const master = ms[0]!;
    const masterVol = this.vol[master.device.deviceId];
    return html`
      <div class="card">
        <div class="row master">
          <span class="name">Group volume <span class="badge">${ms.length} speakers</span></span>
          <span class="pct">${masterVol?.actual ?? 0}%</span>
        </div>
        <input type="range" min="0" max="100" .value=${String(masterVol?.actual ?? 0)}
               @input=${(e: Event) => this.setMaster(Number((e.target as HTMLInputElement).value))} />
        <div class="divider"></div>
        ${ms.map(({ device, role }) => {
          const v = this.vol[device.deviceId];
          return html`
            <div class="row">
              <span class="name">${device.name} ${role === "master" ? html`<span class="badge">master</span>` : ""}</span>
              <span class="pct">${v?.actual ?? 0}%</span>
            </div>
            <input type="range" min="0" max="100" .value=${String(v?.actual ?? 0)}
                   @input=${(e: Event) => this.setMember(device.deviceId, Number((e.target as HTMLInputElement).value))} />
          `;
        })}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-zone-volumes": StZoneVolumes; } }
