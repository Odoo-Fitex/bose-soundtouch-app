import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, type Preset, type Scene, type Schedule } from "../api.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

@customElement("st-schedules")
export class StSchedules extends LitElement {
  @state() private schedules: Schedule[] = [];
  @state() private presets: Preset[] = [];
  @state() private scenes: Scene[] = [];

  // form
  @state() private label = "Wake up";
  @state() private time = "07:00";
  @state() private days: Set<number> = new Set([1,2,3,4,5]); // mon-fri
  @state() private presetId = "";
  @state() private sceneId = "";
  @state() private rampFrom: number | null = 5;
  @state() private rampTo: number | null = 35;
  @state() private rampSeconds: number | null = 90;
  @state() private editingId: string | null = null;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    .day { padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-muted); }
    .day.on { background: var(--accent); color: #0a1224; border-color: transparent; }
    .schedule { display: flex; justify-content: space-between; align-items: center;
      padding: 14px; background: var(--bg-elevated); border-radius: 14px; margin-bottom: 8px; }
  `;

  connectedCallback(): void { super.connectedCallback(); this.refresh(); }
  private async refresh() {
    try {
      const [s, p, sc] = await Promise.all([api.schedules(), api.presets(), api.scenes()]);
      this.schedules = s; this.presets = p; this.scenes = sc;
      if (!this.presetId && p[0]) this.presetId = p[0].id;
    } catch (e) { console.warn(e); }
  }

  private toggleDay(d: number) {
    if (this.days.has(d)) this.days.delete(d); else this.days.add(d);
    this.requestUpdate();
  }

  private cron(): string {
    const [h, m] = this.time.split(":").map(Number);
    const dow = this.days.size === 7 || this.days.size === 0 ? "*" : [...this.days].sort().join(",");
    return `${m ?? 0} ${h ?? 0} * * ${dow}`;
  }

  private async save() {
    if (!this.presetId) { alert("Pick a preset first."); return; }
    await api.saveSchedule({
      id: this.editingId ?? undefined,
      label: this.label.trim() || "Schedule",
      cron: this.cron(),
      scene_id: this.sceneId || null,
      speaker_id: null,
      preset_id: this.presetId,
      ramp_from: this.rampFrom,
      ramp_to: this.rampTo,
      ramp_seconds: this.rampSeconds,
      enabled: 1,
    });
    this.editingId = null;
    await this.refresh();
  }

  private async toggle(s: Schedule) {
    await api.saveSchedule({ ...s, enabled: s.enabled ? 0 : 1 });
    await this.refresh();
  }
  private async erase(id: string) { await api.deleteSchedule(id); await this.refresh(); }
  private edit(s: Schedule) {
    this.editingId = s.id;
    this.label = s.label;
    const m = s.cron.match(/^(\d+) (\d+) \* \* (.+)$/);
    if (m) {
      this.time = `${String(m[2]).padStart(2,"0")}:${String(m[1]).padStart(2,"0")}`;
      this.days = new Set(m[3] === "*" ? [0,1,2,3,4,5,6] : (m[3]?.split(",").map(Number) ?? []));
    }
    this.presetId = s.preset_id;
    this.sceneId = s.scene_id ?? "";
    this.rampFrom = s.ramp_from;
    this.rampTo = s.ramp_to;
    this.rampSeconds = s.ramp_seconds;
  }

  render() {
    return html`
      <div class="scroll">
        <h1>Schedule</h1>
        <p class="muted">Wake-up radio, automatic shut-off, anything time-based.</p>

        <div class="card col">
          <h3>${this.editingId ? "Edit alarm" : "New alarm"}</h3>
          <input type="text" .value=${this.label} @input=${(e: Event) => (this.label = (e.target as HTMLInputElement).value)} />
          <div class="row" style="gap: 10px;">
            <span style="flex:1">Time</span>
            <input type="time" .value=${this.time} @input=${(e: Event) => (this.time = (e.target as HTMLInputElement).value)} style="width: 120px;" />
          </div>
          <div class="row" style="flex-wrap: wrap; gap: 6px;">
            ${DOW.map((name, i) => html`
              <button class="day ${this.days.has(i) ? "on" : ""}" @click=${() => this.toggleDay(i)}>${name}</button>
            `)}
          </div>
          <label>Preset</label>
          <select .value=${this.presetId} @change=${(e: Event) => (this.presetId = (e.target as HTMLSelectElement).value)}>
            ${this.presets.map(p => html`<option value=${p.id}>${p.label} (${p.kind})</option>`)}
          </select>
          <label>Apply scene first (optional)</label>
          <select .value=${this.sceneId} @change=${(e: Event) => (this.sceneId = (e.target as HTMLSelectElement).value)}>
            <option value="">— none —</option>
            ${this.scenes.map(s => html`<option value=${s.id}>${s.label}</option>`)}
          </select>
          <div class="row" style="gap: 8px;">
            <span style="flex:1">Volume ramp</span>
            <input type="number" min="0" max="100" placeholder="from" style="width:80px" .value=${this.rampFrom == null ? "" : String(this.rampFrom)}
                   @input=${(e: Event) => (this.rampFrom = (e.target as HTMLInputElement).value === "" ? null : Number((e.target as HTMLInputElement).value))} />
            <span>→</span>
            <input type="number" min="0" max="100" placeholder="to" style="width:80px" .value=${this.rampTo == null ? "" : String(this.rampTo)}
                   @input=${(e: Event) => (this.rampTo = (e.target as HTMLInputElement).value === "" ? null : Number((e.target as HTMLInputElement).value))} />
            <span>over</span>
            <input type="number" min="0" max="600" placeholder="sec" style="width:80px" .value=${this.rampSeconds == null ? "" : String(this.rampSeconds)}
                   @input=${(e: Event) => (this.rampSeconds = (e.target as HTMLInputElement).value === "" ? null : Number((e.target as HTMLInputElement).value))} />
          </div>
          <button class="btn btn-primary" @click=${() => this.save()}>${this.editingId ? "Update" : "Save alarm"}</button>
        </div>

        <h2>Saved alarms</h2>
        ${this.schedules.length === 0
          ? html`<div class="muted">None yet.</div>`
          : this.schedules.map(s => html`
              <div class="schedule">
                <div>
                  <div>${s.label}</div>
                  <div class="muted" style="font-size:12px;">${s.cron}</div>
                </div>
                <div class="row" style="gap:8px;">
                  <button class="btn ${s.enabled ? "btn-primary" : ""}" @click=${() => this.toggle(s)}>${s.enabled ? "On" : "Off"}</button>
                  <button class="btn" @click=${() => this.edit(s)}>Edit</button>
                  <button class="btn btn-danger" @click=${() => this.erase(s.id)}>✕</button>
                </div>
              </div>
            `)}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-schedules": StSchedules; } }
