import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker } from "../store.js";
import { api, type Device, type Preset } from "../api.js";

@customElement("st-presets")
export class StPresets extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private presets: Preset[] = [];
  @state() private extras: Preset[] = [];
  @state() private busy = "";

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    .grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
    }
    .tile {
      aspect-ratio: 1.4 / 1;
      border: 1px solid var(--border); border-radius: 14px;
      background: var(--bg-elevated);
      padding: 12px; display: flex; flex-direction: column; justify-content: space-between;
      text-align: left;
    }
    .tile.empty { color: var(--fg-muted); border-style: dashed; }
    .tile .label { font-weight: 600; font-size: 16px; }
    .tile .kind { color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .extras { margin-top: 24px; display: grid; grid-template-columns: 1fr; gap: 8px; }
    .extra { display: flex; justify-content: space-between; align-items: center; padding: 14px; background: var(--bg-elevated); border-radius: 14px; }
    .extra .row-actions { display: flex; gap: 8px; }
    .pill { padding: 4px 8px; background: var(--accent-strong); border-radius: 999px; font-size: 11px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; this.load(); }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.load(); }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

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
    this.busy = id;
    try { await api.playPreset(id); } finally { this.busy = ""; }
  }

  private async erase(id: string) {
    await api.deletePreset(id);
    await this.load();
  }

  render() {
    if (!this.selected) return html`<div class="scroll"><div class="card">Pick a speaker first.</div></div>`;
    const presetForSlot = (slot: number) => this.presets.find(p => p.slot === slot);
    return html`
      <div class="scroll">
        <h1>Presets</h1>
        <p class="muted" style="margin-top:-4px">
          Tap to play. The six tiles below are bound to the hardware preset buttons on the
          speaker — pressing button 3 on the speaker plays preset 3.
        </p>
        <div class="grid">
          ${[1,2,3,4,5,6].map(slot => {
            const p = presetForSlot(slot);
            return p
              ? html`<button class="tile" @click=${() => this.play(p.id)}>
                  <div class="kind">${p.kind} · slot ${slot}</div>
                  <div class="label">${p.label}</div>
                  <div class="row" style="justify-content: space-between;">
                    <span class="muted" style="font-size:12px;">${this.busy === p.id ? "playing…" : ""}</span>
                    <button class="btn-ghost" @click=${(e: Event) => { e.stopPropagation(); this.erase(p.id); }}>✕</button>
                  </div>
                </button>`
              : html`<button class="tile empty" @click=${() => this.dispatchEvent(new CustomEvent("create-preset", { detail: { slot, speakerId: this.selected }, bubbles: true, composed: true }))}>
                  <div class="kind">Empty · slot ${slot}</div>
                  <div class="label">＋ Add</div>
                  <div class="muted" style="font-size:12px;">Tap to bind to slot ${slot}</div>
                </button>`;
          })}
        </div>

        <h2>Shared presets</h2>
        <div class="extras">
          ${this.extras.length === 0
            ? html`<div class="card muted">None yet — create one from the Browse tab.</div>`
            : this.extras.map(p => html`
                <div class="extra">
                  <div>
                    <div>${p.label}</div>
                    <div class="muted" style="font-size:12px;">${p.kind}${p.scene_id ? html` · <span class="pill">scene</span>` : ""}</div>
                  </div>
                  <div class="row-actions">
                    <button class="btn" @click=${() => this.play(p.id)}>Play</button>
                    <button class="btn btn-danger" @click=${() => this.erase(p.id)}>Delete</button>
                  </div>
                </div>
              `)}
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-presets": StPresets; } }
