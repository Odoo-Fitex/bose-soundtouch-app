import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker, $now, $vol, $sleepAt, press, setVolume } from "../store.js";
import type { Device, NowPlaying, Volume } from "../api.js";

/**
 * Slim docked player above the bottom nav. Always visible when a speaker is
 * selected; provides transport, volume tap, and a sleep-timer entry point.
 */
@customElement("st-mini-player")
export class StMiniPlayer extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private np: NowPlaying | undefined;
  @state() private vol: Volume | undefined;
  @state() private sleepAt: number | null = null;
  @state() private now = Date.now();

  static styles = css`
    :host { display: block; }
    .bar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 8px 12px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border);
    }
    .meta { min-width: 0; }
    .title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; align-items: center; gap: 6px; }
    button.icon {
      width: 36px; height: 36px;
      display: grid; place-items: center;
      border-radius: 10px;
      background: transparent;
      color: var(--fg);
    }
    button.icon:hover { background: var(--accent-strong); }
    button.icon.play { background: var(--accent); color: #0a1224; }
    .countdown {
      font-size: 11px; color: var(--accent); font-variant-numeric: tabular-nums;
      padding: 2px 8px; border-radius: 999px;
      background: var(--accent-strong);
    }
    .vol-bar {
      grid-column: 1 / -1;
      height: 2px;
      background: var(--accent);
      transform-origin: left;
      transition: transform 120ms ease-out;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.refresh(); }));
    this.unsub.push($now.subscribe(() => this.refresh()));
    this.unsub.push($vol.subscribe(() => this.refresh()));
    this.unsub.push($sleepAt.subscribe(v => { this.sleepAt = v; }));
    this.tickHandle = window.setInterval(() => { this.now = Date.now(); }, 1000);
  }
  disconnectedCallback(): void {
    this.unsub.forEach(f => f());
    if (this.tickHandle) clearInterval(this.tickHandle);
    super.disconnectedCallback();
  }
  private unsub: (() => void)[] = [];
  private tickHandle: number | null = null;

  private refresh() {
    if (!this.selected) return;
    this.np = $now.get()[this.selected];
    this.vol = $vol.get()[this.selected];
  }

  private playing() {
    return this.np?.playStatus === "PLAY_STATE" || this.np?.playStatus === "BUFFERING_STATE";
  }

  private sleepCountdown(): string | null {
    if (!this.sleepAt) return null;
    const left = Math.max(0, this.sleepAt - this.now);
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  private bumpVolume(delta: number) {
    if (!this.selected) return;
    const cur = this.vol?.actual ?? 0;
    setVolume(this.selected, Math.max(0, Math.min(100, cur + delta)));
  }

  private deviceName(): string {
    const id = this.selected;
    return this.devices.find(d => d.deviceId === id)?.name ?? "—";
  }

  render() {
    if (!this.selected) return html``;
    const id = this.selected;
    const playPause = this.playing() ? "PAUSE" : "PLAY";
    const title = this.np?.track || this.np?.stationName || this.np?.contentItem?.itemName || this.deviceName();
    const sub = [this.np?.artist, this.np?.album].filter(Boolean).join(" · ") ||
                (this.np && this.np.source !== "STANDBY" ? this.np.source : "Idle");
    const cd = this.sleepCountdown();
    const volPct = (this.vol?.actual ?? 0) / 100;
    return html`
      <div class="bar">
        <div class="meta">
          <div class="title">${title}</div>
          <div class="sub">${this.deviceName()} · ${sub}</div>
        </div>
        <div class="actions">
          ${cd ? html`<span class="countdown" title="Sleep timer">⏰ ${cd}</span>` : ""}
          <button class="icon" title="Sleep timer"
                  @click=${() => this.dispatchEvent(new CustomEvent("open-sleep", { bubbles: true, composed: true }))}>
            ☾
          </button>
          <button class="icon" title="Volume −" @click=${() => this.bumpVolume(-3)}>−</button>
          <button class="icon" title="Volume +" @click=${() => this.bumpVolume(+3)}>+</button>
          <button class="icon play" title="Play / pause" @click=${() => press(id, playPause)}>
            ${this.playing() ? "⏸" : "▶"}
          </button>
        </div>
        <div class="vol-bar" style="transform: scaleX(${volPct});"></div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-mini-player": StMiniPlayer; } }
