import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker, $now, isImageUrl } from "../store.js";
import { api, type Device, type NowPlaying, type Preset, type RadioStation } from "../api.js";

@customElement("st-presets")
export class StPresets extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private presets: Preset[] = [];
  @state() private extras: Preset[] = [];
  @state() private busy = "";
  @state() private picker: { slot: number } | null = null;
  @state() private np: NowPlaying | undefined;

  // Picker working state
  @state() private radioQ = "";
  @state() private radioBusy = false;
  @state() private radioHits: RadioStation[] = [];

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    /* The slot grid has fixed 6 cells. Use 2 cols on phones, 3 on tablets,
       6 on a wide desktop so tiles stay small instead of stretching to
       fill the row width. */
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    @media (min-width: 600px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    @media (min-width: 960px) { .grid { grid-template-columns: repeat(6, 1fr); } }
    .tile {
      /* Drop the old 1.4:1 aspect ratio that caused massive vertical
         stretching on wide viewports. Use a compact fixed min-height so
         every slot tile is the same size whether on phone or desktop. */
      min-height: 96px;
      border: 1px solid var(--border); border-radius: 14px;
      background: var(--bg-elevated);
      padding: 10px;
      display: grid;
      grid-template-columns: 40px 1fr auto;
      grid-template-rows: auto 1fr;
      grid-template-areas:
        "art kind  del"
        "art label label";
      gap: 4px 10px; align-items: center;
      text-align: left;
      cursor: pointer;
      transition: transform 80ms ease-out;
      /* The tile is a div (not button) so we can put a real <button> for
         delete inside without the browser splitting nested buttons into
         two sibling grid cells. */
      font: inherit; color: inherit; user-select: none;
    }
    .tile:active { transform: scale(0.98); }
    .tile.empty {
      color: var(--fg-muted); border-style: dashed;
      /* No artwork in empty state; collapse the grid back to a centered
         "+ Add" cell. */
      grid-template-columns: 1fr; grid-template-areas: "label" "kind";
      text-align: center;
    }
    .tile .art {
      grid-area: art;
      width: 40px; height: 40px; border-radius: 8px;
      background: var(--accent-strong);
      display: grid; place-items: center;
      overflow: hidden; font-size: 18px; flex-shrink: 0;
    }
    .tile .art img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .tile .label {
      grid-area: label;
      font-weight: 600; font-size: 14px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tile .kind {
      grid-area: kind;
      color: var(--fg-muted); font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .tile .del {
      grid-area: del;
      background: transparent; border: 0; color: var(--fg-muted);
      width: 24px; height: 24px; border-radius: 6px; cursor: pointer;
      font-size: 14px; line-height: 1;
    }
    .tile .del:hover { background: var(--bg); color: var(--danger); }

    .extras { margin-top: 24px; display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 720px) { .extras { grid-template-columns: repeat(2, 1fr); } }
    .extra {
      display: grid; grid-template-columns: 36px 1fr auto auto;
      gap: 10px; align-items: center;
      padding: 10px 12px; background: var(--bg-elevated); border-radius: 12px;
    }
    .extra .art {
      width: 36px; height: 36px; border-radius: 8px;
      background: var(--accent-strong);
      display: grid; place-items: center; overflow: hidden; font-size: 16px;
    }
    .extra .art img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .extra .meta { min-width: 0; }
    .extra .meta .label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .extra .row-actions { display: flex; gap: 6px; }
    .pill { padding: 4px 8px; background: var(--accent-strong); border-radius: 999px; font-size: 11px; }
    .btn { padding: 8px 12px; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg); }
    .btn-primary { background: var(--accent); color: #0a1224; border-color: transparent; font-weight: 600; }
    .btn-danger { color: var(--danger); }
    .btn-ghost { background: transparent; border: 0; color: var(--fg-muted); }

    /* Picker modal */
    .modal {
      position: fixed; inset: 0; z-index: 60;
      background: rgba(8, 12, 22, 0.6);
      display: flex; align-items: flex-end; justify-content: center;
      animation: fade 160ms ease-out;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .sheet {
      width: 100%; max-width: 520px; max-height: 85vh; overflow-y: auto;
      background: var(--bg-elevated);
      border-top-left-radius: 18px; border-top-right-radius: 18px;
      padding: 18px 18px calc(18px + env(safe-area-inset-bottom));
      box-shadow: 0 -10px 30px rgba(0,0,0,0.4);
      animation: slide 200ms ease-out;
    }
    @keyframes slide { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .sheet h2 { margin: 0 0 4px; font-size: 18px; }
    .sheet .muted { color: var(--fg-muted); margin: 0 0 16px; font-size: 13px; }
    .sheet h3 { margin: 18px 0 8px; font-size: 13px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row input { flex: 1; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; }
    .now-card { display: flex; gap: 12px; align-items: center; padding: 12px; background: var(--bg); border-radius: 12px; border: 1px solid var(--border); }
    .now-card .meta { flex: 1; min-width: 0; }
    .now-card .label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .now-card .sub { color: var(--fg-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opt {
      display: flex; align-items: center; gap: 10px; padding: 10px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      margin-bottom: 6px; width: 100%; text-align: left; color: var(--fg); font: inherit;
    }
    .opt:hover, .opt:focus { background: var(--accent-strong); }
    .opt-meta { flex: 1; min-width: 0; }
    .opt-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opt-sub { color: var(--fg-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon { width: 32px; height: 32px; border-radius: 8px; background: var(--accent-strong); display: grid; place-items: center; flex-shrink: 0; font-size: 14px; }
    .icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; this.load(); }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.load(); this.refreshNow(); }));
    this.unsub.push($now.subscribe(() => this.refreshNow()));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private refreshNow() {
    if (!this.selected) return;
    this.np = $now.get()[this.selected];
  }

  private async load() {
    if (!this.selected) return;
    try {
      const all = await api.presets();
      this.presets = all.filter(p => p.speaker_id === this.selected && p.slot != null);
      this.extras = all.filter(p => !p.speaker_id || p.slot == null);
    } catch (e) {
      console.warn("presets load failed", e);
    }
  }

  private async play(id: string) {
    // Pass the live $selectedSpeaker so the preset routes to the room the
    // user has selected at the top, not whichever room was bound when the
    // preset was originally saved.
    const speakerId = $selectedSpeaker.get();
    this.busy = id;
    try { await api.playPreset(id, speakerId ? { speakerId } : {}); }
    catch (e) { alert(`Play failed: ${e}`); }
    finally { this.busy = ""; }
  }

  private async erase(id: string) {
    await api.deletePreset(id);
    await this.load();
  }

  /** Confirm-then-delete wrapper used by the tile ✕ button. Without the
   * confirm a stray fingertip on the corner of a tile would silently
   * obliterate a hardware-bound preset, which is annoying enough to ask
   * for confirmation even on a personal-use app. */
  private async confirmErase(p: Preset) {
    if (!confirm(`Delete preset "${p.label}"?`)) return;
    try { await this.erase(p.id); }
    catch (e) { alert(`Delete failed: ${e}`); }
  }

  /** Choose a kind-specific glyph when no artwork URL is on file. */
  private fallbackGlyph(p: Preset): string {
    switch (p.kind) {
      case "radio": return "📻";
      case "nas": return "🎵";
      case "podcast": return "🎙️";
      case "aux": return "🎧";
      case "spotify_uri": return "♪";
      default: return "★";
    }
  }

  // ---- Picker -----------------------------------------------------------------

  private openPicker(slot: number) {
    this.picker = { slot };
    this.radioQ = ""; this.radioHits = [];
  }
  private closePicker() { this.picker = null; }

  private async searchRadio() {
    if (!this.radioQ.trim()) return;
    this.radioBusy = true;
    try {
      this.radioHits = await api.radioSearch({ name: this.radioQ, limit: 10 });
    } finally { this.radioBusy = false; }
  }

  private async bindFromCurrent() {
    if (!this.picker || !this.selected || !this.np) return;
    const slot = this.picker.slot;
    const ci = this.np.contentItem;
    if (!ci) { alert("Nothing to bind right now."); return; }
    const label = this.np.stationName || this.np.track || ci.itemName || `Slot ${slot}`;

    // If the URL is one of our radio stream URLs (http://<pi>:<port>/stream/r-<uuid>)
    // recover the uuid and save as a real radio preset so a future MediaServer
    // UUID rotation doesn't break the link.
    const radioMatch = ci.location?.match(/\/stream\/r-([a-f0-9-]+)/i);
    if (radioMatch) {
      await api.savePreset({
        label, kind: "radio",
        speaker_id: this.selected,
        slot,
        payload: JSON.stringify({ uuid: radioMatch[1] }),
        artwork_url: this.np.artUrl ?? null,
      });
    } else {
      // Anything else (AUX, BLUETOOTH, foreign UPnP) — save the raw item.
      await api.savePreset({
        label, kind: "raw",
        speaker_id: this.selected,
        slot,
        payload: JSON.stringify({ item: ci }),
        artwork_url: this.np.artUrl ?? null,
      });
    }
    await this.load();
    this.closePicker();
  }

  private async bindExisting(p: Preset) {
    if (!this.picker || !this.selected) return;
    const slot = this.picker.slot;
    let payload: unknown;
    try { payload = JSON.parse(p.payload); } catch { payload = {}; }
    await api.savePreset({
      id: p.speaker_id == null && p.slot == null ? undefined : p.id, // shared -> new bound copy
      label: p.label,
      kind: p.kind,
      speaker_id: this.selected,
      slot,
      payload: JSON.stringify(payload),
      artwork_url: p.artwork_url,
    });
    await this.load();
    this.closePicker();
  }

  private async bindRadio(s: RadioStation) {
    if (!this.picker || !this.selected) return;
    const slot = this.picker.slot;
    await api.savePreset({
      label: s.name,
      kind: "radio",
      speaker_id: this.selected,
      slot,
      payload: JSON.stringify({ uuid: s.uuid }),
      artwork_url: s.favicon || null,
    });
    await this.load();
    this.closePicker();
  }

  // ---- Render -----------------------------------------------------------------

  render() {
    if (!this.selected) return html`<div class="scroll"><div class="card">Pick a speaker first.</div></div>`;
    const presetForSlot = (slot: number) => this.presets.find(p => p.slot === slot);
    return html`
      <div class="scroll">
        <h1>Presets</h1>
        <p class="muted" style="margin-top:-4px">
          Tap a tile to play. The six tiles below are bound to the hardware preset buttons on the
          speaker — pressing button 3 on the speaker plays preset 3.
        </p>
        <div class="grid">
          ${[1,2,3,4,5,6].map(slot => {
            const p = presetForSlot(slot);
            return p
              ? html`<div class="tile" role="button" tabindex="0"
                          @click=${() => this.play(p.id)}
                          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") this.play(p.id); }}>
                  <span class="art">${isImageUrl(p.artwork_url)
                    ? html`<img src=${p.artwork_url} alt="" />`
                    : html`<span>${this.fallbackGlyph(p)}</span>`}</span>
                  <div class="kind">${p.kind} · slot ${slot}${this.busy === p.id ? " · playing…" : ""}</div>
                  <div class="label">${p.label}</div>
                  <button class="del" title="Delete preset"
                          @click=${(e: Event) => { e.stopPropagation(); this.confirmErase(p); }}>✕</button>
                </div>`
              : html`<div class="tile empty" role="button" tabindex="0"
                          @click=${() => this.openPicker(slot)}
                          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") this.openPicker(slot); }}>
                  <div class="label">＋ Add</div>
                  <div class="kind">Slot ${slot}</div>
                </div>`;
          })}
        </div>

        <h2>Shared presets</h2>
        <div class="extras">
          ${this.extras.length === 0
            ? html`<div class="card muted">None yet — save one from the Browse tab.</div>`
            : this.extras.map(p => html`
                <div class="extra">
                  <span class="art">${isImageUrl(p.artwork_url)
                    ? html`<img src=${p.artwork_url} alt="" />`
                    : html`<span>${this.fallbackGlyph(p)}</span>`}</span>
                  <div class="meta">
                    <div class="label">${p.label}</div>
                    <div class="muted" style="font-size:12px;">${p.kind}${p.scene_id ? html` · <span class="pill">scene</span>` : ""}</div>
                  </div>
                  <div class="row-actions">
                    <button class="btn" @click=${() => this.play(p.id)}>Play</button>
                    <button class="btn btn-danger" @click=${() => this.confirmErase(p)}>✕</button>
                  </div>
                </div>
              `)}
        </div>
      </div>

      ${this.picker ? this.renderPicker() : ""}
    `;
  }

  private renderPicker() {
    const slot = this.picker!.slot;
    return html`
      <div class="modal" @click=${(e: Event) => { if (e.target === e.currentTarget) this.closePicker(); }}>
        <div class="sheet">
          <h2>Bind preset to slot ${slot}</h2>
          <p class="muted">Pick a source to assign to slot ${slot}. You can change or clear it later.</p>

          ${this.np && this.np.contentItem && this.np.source !== "STANDBY" ? html`
            <h3>Currently playing</h3>
            <div class="now-card">
              <span class="icon">${isImageUrl(this.np.artUrl) ? html`<img src=${this.np.artUrl} alt="" />` : "♪"}</span>
              <div class="meta">
                <div class="label">${this.np.stationName || this.np.track || this.np.contentItem.itemName || "Now playing"}</div>
                <div class="sub">${this.np.source}</div>
              </div>
              <button class="btn btn-primary" @click=${() => this.bindFromCurrent()}>Save</button>
            </div>
          ` : ""}

          <h3>Search a radio station</h3>
          <div class="row">
            <input type="text" placeholder="e.g. RFM, BBC Radio 4" .value=${this.radioQ}
                   @input=${(e: Event) => (this.radioQ = (e.target as HTMLInputElement).value)}
                   @keyup=${(e: KeyboardEvent) => e.key === "Enter" && this.searchRadio()} />
            <button class="btn btn-primary" @click=${() => this.searchRadio()} ?disabled=${this.radioBusy}>${this.radioBusy ? "…" : "Go"}</button>
          </div>
          <div style="height: 8px"></div>
          ${this.radioHits.map(s => html`
            <button class="opt" @click=${() => this.bindRadio(s)}>
              <span class="icon">${isImageUrl(s.favicon) ? html`<img src=${s.favicon} alt="" />` : "📻"}</span>
              <div class="opt-meta">
                <div class="opt-label">${s.name}</div>
                <div class="opt-sub">${s.country} · ${s.codec || "?"} · ${s.bitrate || "?"} kbps</div>
              </div>
            </button>
          `)}

          ${this.extras.length > 0 ? html`
            <h3>From your saved favourites</h3>
            ${this.extras.map(p => html`
              <button class="opt" @click=${() => this.bindExisting(p)}>
                <span class="icon">${isImageUrl(p.artwork_url) ? html`<img src=${p.artwork_url} alt="" />` : "★"}</span>
                <div class="opt-meta">
                  <div class="opt-label">${p.label}</div>
                  <div class="opt-sub">${p.kind}</div>
                </div>
              </button>
            `)}
          ` : ""}

          <div style="height: 12px"></div>
          <button class="btn" style="width:100%" @click=${() => this.closePicker()}>Close</button>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-presets": StPresets; } }
