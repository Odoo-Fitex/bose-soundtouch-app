import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $selectedSpeaker, $now, $vol, $cachedArt, press, isImageUrl } from "../store.js";
import type { NowPlaying, Volume } from "../api.js";
import "./st-zone-volumes.js";
import "./st-favourites.js";
import "./st-search.js";
import "./st-zone-toggle.js";

// Speaker art-status sentinels we should treat as "no real art".
const NO_ART = new Set(["", "INVALID", "DOWNLOADING", "SHOW_DEFAULT_IMAGE"]);

@customElement("st-now-playing")
export class StNowPlaying extends LitElement {
  @state() private selected: string | null = null;
  @state() private np: NowPlaying | undefined;
  @state() private vol: Volume | undefined;
  @state() private cachedArt: Record<string, string> = {};
  @state() private artBroken = false;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 16px; height: 100%; }
    .search-wrap { margin-bottom: 16px; }
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
      margin-bottom: 16px;
    }
    .controls button {
      min-height: 56px; font-size: 22px;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 14px;
    }
    .play { background: var(--accent) !important; color: #0a1224 !important; border-color: transparent !important; }
    .source-pill {
      display: inline-block; padding: 4px 8px; border-radius: 999px;
      font-size: 11px; background: var(--accent-strong); color: var(--fg);
      text-transform: uppercase; letter-spacing: 0.04em; margin-right: 6px;
    }
    .quick { margin-top: 16px; }
    .quick .btn-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn { padding: 10px 14px; border-radius: 12px; background: var(--bg-elevated); color: var(--fg); border: 1px solid var(--border); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.artBroken = false; this.refresh(); }));
    this.unsub.push($now.subscribe(() => { this.artBroken = false; this.refresh(); }));
    this.unsub.push($vol.subscribe(() => this.refresh()));
    this.unsub.push($cachedArt.subscribe(v => { this.cachedArt = { ...v }; }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private refresh() {
    if (!this.selected) return;
    this.np = $now.get()[this.selected];
    this.vol = $vol.get()[this.selected];
  }

  /** Best art URL we have for the current speaker, or null if we should fall
   *  back to the music-note placeholder. */
  private artUrl(): string | null {
    if (this.artBroken) return null;
    const fromSpeaker = this.np?.artUrl ?? "";
    const status = this.np?.artStatus ?? "";
    if (isImageUrl(fromSpeaker) && !NO_ART.has(status)) return fromSpeaker;
    const cached = this.selected ? this.cachedArt[this.selected] : "";
    return isImageUrl(cached) ? cached : null;
  }

  private playing() {
    return this.np?.playStatus === "PLAY_STATE" || this.np?.playStatus === "BUFFERING_STATE";
  }

  private hasContent(): boolean {
    if (!this.np) return false;
    if (this.np.source && this.np.source !== "STANDBY" && this.np.source !== "INVALID_SOURCE") return true;
    if (this.np.contentItem && this.np.contentItem.source !== "STANDBY") return true;
    return false;
  }

  render() {
    if (!this.selected) {
      return html`<div class="scroll"><div class="search-wrap"><st-search></st-search></div><st-favourites></st-favourites></div>`;
    }
    const id = this.selected;
    const playPause = this.playing() ? "PAUSE" : "PLAY";
    const title = this.np?.track || this.np?.stationName || this.np?.contentItem?.itemName || "—";
    const subtitle = [this.np?.artist, this.np?.album].filter(Boolean).join(" · ") ||
                     this.np?.description || this.np?.stationLocation || "";
    const source = this.np?.source ?? "";

    return html`
      <div class="scroll">
        <div class="search-wrap"><st-search></st-search></div>

        ${this.hasContent() ? html`
          <div class="art">
            ${(() => {
              const u = this.artUrl();
              return u
                ? html`<img src=${u} alt=""
                            @error=${() => { this.artBroken = true; }} />`
                : html`<span style="font-size:48px">♪</span>`;
            })()}
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
        ` : html`
          <st-favourites></st-favourites>
        `}

        <st-zone-toggle></st-zone-toggle>
        <st-zone-volumes speaker-id=${id}></st-zone-volumes>

        <div class="quick">
          <h3 style="margin:16px 0 8px; color: var(--fg-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Quick actions</h3>
          <div class="btn-row">
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
