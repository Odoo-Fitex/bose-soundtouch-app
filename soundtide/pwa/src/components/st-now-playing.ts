import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  $devices, $selectedSpeaker, $now, $vol, press, setVolume, toggleMute,
} from "../store.js";
import type { Device, NowPlaying, Volume } from "../api.js";

@customElement("st-now-playing")
export class StNowPlaying extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private np: NowPlaying | undefined;
  @state() private vol: Volume | undefined;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 16px; height: 100%; }
    .speakers {
      display: flex; gap: 8px; overflow-x: auto;
      padding-bottom: 8px;
      scroll-snap-type: x mandatory;
      margin: 0 -16px 16px; padding-left: 16px; padding-right: 16px;
    }
    .speaker {
      flex: 0 0 auto;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-elevated);
      color: var(--fg-muted);
      scroll-snap-align: start;
      min-height: 44px;
    }
    .speaker.active { border-color: var(--accent); color: var(--fg); }
    .speaker.offline { opacity: 0.5; }
    .art {
      width: min(280px, 70vw); height: min(280px, 70vw);
      border-radius: 18px;
      background: linear-gradient(135deg, var(--accent-strong), var(--bg-elevated));
      display: grid; place-items: center;
      margin: 8px auto 16px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    .art img { width: 100%; height: 100%; object-fit: cover; }
    .meta { text-align: center; margin-bottom: 24px; min-height: 60px; }
    .meta .title { font-size: 22px; font-weight: 600; }
    .meta .sub { color: var(--fg-muted); margin-top: 4px; }
    .controls {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
      margin-bottom: 24px;
    }
    .controls button {
      min-height: 56px; font-size: 22px;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 14px;
    }
    .play { background: var(--accent) !important; color: #0a1224 !important; border-color: transparent !important; }
    .vol { display: flex; align-items: center; gap: 12px; }
    .vol input { flex: 1; }
    .source-pill {
      display: inline-block; padding: 4px 8px; border-radius: 999px;
      font-size: 11px; background: var(--accent-strong); color: var(--fg);
      text-transform: uppercase; letter-spacing: 0.04em; margin-right: 6px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.refresh(); }));
    this.unsub.push($now.subscribe(() => this.refresh()));
    this.unsub.push($vol.subscribe(() => this.refresh()));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private refresh() {
    if (!this.selected) return;
    this.np = $now.get()[this.selected];
    this.vol = $vol.get()[this.selected];
  }

  private select(id: string) { $selectedSpeaker.set(id); }

  private playing() {
    return this.np?.playStatus === "PLAY_STATE" || this.np?.playStatus === "BUFFERING_STATE";
  }

  render() {
    if (!this.selected) return html`<div class="scroll"><div class="card">Looking for speakers…</div></div>`;
    const id = this.selected;
    const playPause = this.playing() ? "PAUSE" : "PLAY";
    const title = this.np?.track || this.np?.stationName || this.np?.contentItem?.itemName || "—";
    const subtitle = [this.np?.artist, this.np?.album].filter(Boolean).join(" · ") ||
                     this.np?.description || this.np?.stationLocation || "";
    const source = this.np?.source ?? "";
    return html`
      <div class="scroll">
        <div class="speakers">
          ${this.devices.map(d => html`
            <button class="speaker ${d.deviceId === id ? "active" : ""} ${d.online ? "" : "offline"}"
                    @click=${() => this.select(d.deviceId)}>${d.name}</button>
          `)}
        </div>

        <div class="art">
          ${this.np?.artUrl ? html`<img src=${this.np.artUrl} alt="" />` : html`<span style="font-size:48px">♪</span>`}
        </div>
        <div class="meta">
          <div class="title">${title}</div>
          <div class="sub">${source ? html`<span class="source-pill">${source}</span>` : ""}${subtitle}</div>
        </div>

        <div class="controls">
          <button @click=${() => press(id, "PREV_TRACK")}>⏮</button>
          <button @click=${() => press(id, "REPEAT_OFF")}>↻</button>
          <button class="play" @click=${() => press(id, playPause)}>${this.playing() ? "⏸" : "▶"}</button>
          <button @click=${() => press(id, "SHUFFLE_ON")}>⤮</button>
          <button @click=${() => press(id, "NEXT_TRACK")}>⏭</button>
        </div>

        <div class="card col">
          <div class="row">
            <span>Volume</span>
            <span class="muted">${this.vol?.actual ?? 0}%</span>
          </div>
          <div class="vol">
            <button @click=${() => toggleMute(id)} title="Mute">${this.vol?.muted ? "🔇" : "🔊"}</button>
            <input type="range" min="0" max="100" .value=${String(this.vol?.actual ?? 0)}
                   @input=${(e: Event) => setVolume(id, Number((e.target as HTMLInputElement).value))} />
          </div>
        </div>

        <div style="height: 16px"></div>
        <div class="card col">
          <h3>Quick actions</h3>
          <div class="row" style="flex-wrap: wrap; gap: 8px;">
            <button class="btn" @click=${() => press(id, "AUX_INPUT")}>AUX</button>
            <button class="btn" @click=${() => press(id, "VOLUME_DOWN")}>Vol −</button>
            <button class="btn" @click=${() => press(id, "VOLUME_UP")}>Vol +</button>
            <button class="btn" @click=${() => press(id, "POWER")}>Power</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-now-playing": StNowPlaying; } }
