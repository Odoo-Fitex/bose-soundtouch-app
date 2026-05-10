import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker, $now } from "../store.js";
import type { Device, NowPlaying } from "../api.js";

/**
 * Horizontal scroller of speaker pills. Each pill shows the speaker name,
 * an online dot, and a one-line "now playing" hint. Tap to switch.
 *
 * Used at the top of every screen. Replaces the inline speakers row that
 * used to live inside st-now-playing.
 */
@customElement("st-room-strip")
export class StRoomStrip extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private now: Record<string, NowPlaying> = {};

  static styles = css`
    :host { display: block; }
    .strip {
      display: flex; gap: 8px; overflow-x: auto;
      padding: 8px 16px 12px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    .pill {
      flex: 0 0 auto;
      min-width: 110px;
      padding: 8px 12px;
      border-radius: 14px;
      background: var(--bg-elevated);
      border: 2px solid var(--border);
      color: var(--fg-muted);
      scroll-snap-align: start;
      text-align: left;
      cursor: pointer;
      transition: transform 80ms ease-out, background-color 120ms ease-out;
    }
    .pill:active { transform: scale(0.96); }
    .pill.active {
      border-color: var(--accent);
      background: var(--accent-strong);
      color: var(--fg);
      font-weight: 600;
    }
    .pill.offline { opacity: 0.45; }
    .head { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
    .dot.off { background: var(--danger); }
    .sub { font-size: 11px; color: var(--fg-muted); margin-top: 2px;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; }));
    this.unsub.push($now.subscribe(v => { this.now = { ...v }; }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private hint(d: Device): string {
    const np = this.now[d.deviceId];
    if (!np) return d.online ? "—" : "offline";
    if (np.playStatus === "PLAY_STATE" || np.playStatus === "BUFFERING_STATE") {
      return np.track || np.stationName || np.contentItem?.itemName || "Playing";
    }
    if (np.source === "STANDBY" || !np.source) return "idle";
    return np.source.toLowerCase();
  }

  render() {
    if (this.devices.length === 0) return html``;
    return html`
      <div class="strip">
        ${this.devices.map(d => html`
          <button class="pill ${d.deviceId === this.selected ? "active" : ""} ${d.online ? "" : "offline"}"
                  @click=${() => {
                    console.log("[room-strip] selecting", d.name, d.deviceId);
                    $selectedSpeaker.set(d.deviceId);
                  }}>
            <div class="head"><span class="dot ${d.online ? "" : "off"}"></span>${d.name}</div>
            <div class="sub">${this.hint(d)}</div>
          </button>
        `)}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-room-strip": StRoomStrip; } }
