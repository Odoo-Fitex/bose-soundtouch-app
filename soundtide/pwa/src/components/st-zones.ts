import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices } from "../store.js";
import { api, type Device, type Scene } from "../api.js";

@customElement("st-zones")
export class StZones extends LitElement {
  @state() private devices: Device[] = [];
  @state() private scenes: Scene[] = [];
  @state() private masterId: string = "";
  @state() private slaves: Set<string> = new Set();
  @state() private label = "";
  @state() private editingId: string | null = null;
  @state() private defaultVolume: number | null = null;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    .speaker-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px;
      background: var(--bg-elevated); margin-bottom: 8px;
    }
    .role { padding: 4px 8px; background: var(--accent-strong); border-radius: 999px; font-size: 11px; }
    .role.empty { background: transparent; color: var(--fg-muted); border: 1px dashed var(--border); }
    .scenes { display: grid; gap: 8px; }
    .scene { display: flex; justify-content: space-between; align-items: center;
      padding: 14px; background: var(--bg-elevated); border-radius: 14px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.refreshScenes();
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private async refreshScenes() {
    try { this.scenes = await api.scenes(); } catch (e) { console.warn(e); }
  }

  private setMaster(id: string) {
    this.masterId = id;
    this.slaves.delete(id);
    this.requestUpdate();
  }

  private toggleSlave(id: string) {
    if (id === this.masterId) return;
    if (this.slaves.has(id)) this.slaves.delete(id); else this.slaves.add(id);
    this.requestUpdate();
  }

  private async save() {
    if (!this.masterId || !this.label.trim()) return;
    await api.saveScene({
      id: this.editingId ?? undefined,
      label: this.label.trim(),
      master_id: this.masterId,
      slave_ids: JSON.stringify([...this.slaves]),
      default_volume: this.defaultVolume,
    });
    this.label = ""; this.masterId = ""; this.slaves = new Set(); this.editingId = null; this.defaultVolume = null;
    await this.refreshScenes();
  }

  private async apply(id: string) { await api.applyScene(id); }
  private async erase(id: string) { await api.deleteScene(id); await this.refreshScenes(); }

  private edit(s: Scene) {
    this.editingId = s.id;
    this.label = s.label;
    this.masterId = s.master_id;
    this.slaves = new Set(JSON.parse(s.slave_ids));
    this.defaultVolume = s.default_volume;
  }

  render() {
    return html`
      <div class="scroll">
        <h1>Zones</h1>
        <p class="muted">Group speakers to play the same source in sample-sync.</p>

        <div class="card col">
          <h3>${this.editingId ? "Edit scene" : "New scene"}</h3>
          <input type="text" placeholder="Name (e.g. Whole house)" .value=${this.label}
                 @input=${(e: Event) => (this.label = (e.target as HTMLInputElement).value)} />
          <div>
            ${this.devices.map(d => html`
              <div class="speaker-row">
                <span style="flex: 1">${d.name}</span>
                <button class="role ${d.deviceId === this.masterId ? "" : "empty"}"
                        @click=${() => this.setMaster(d.deviceId)}>Master</button>
                <button class="role ${this.slaves.has(d.deviceId) ? "" : "empty"}"
                        @click=${() => this.toggleSlave(d.deviceId)}>Member</button>
              </div>
            `)}
          </div>
          <div class="row">
            <span class="muted" style="flex: 1">Default volume</span>
            <input type="number" min="0" max="100" placeholder="—" style="width:80px"
                   .value=${this.defaultVolume == null ? "" : String(this.defaultVolume)}
                   @input=${(e: Event) => {
                     const v = (e.target as HTMLInputElement).value.trim();
                     this.defaultVolume = v === "" ? null : Math.max(0, Math.min(100, Number(v)));
                   }} />
          </div>
          <button class="btn btn-primary" @click=${() => this.save()}>${this.editingId ? "Update scene" : "Save scene"}</button>
        </div>

        <h2>Saved scenes</h2>
        <div class="scenes">
          ${this.scenes.length === 0
            ? html`<div class="muted">None yet.</div>`
            : this.scenes.map(s => html`
                <div class="scene">
                  <div>
                    <div>${s.label}</div>
                    <div class="muted" style="font-size:12px;">
                      Master ${this.deviceName(s.master_id)} · ${(JSON.parse(s.slave_ids) as string[]).length} member(s)
                    </div>
                  </div>
                  <div class="row" style="gap: 8px;">
                    <button class="btn btn-primary" @click=${() => this.apply(s.id)}>Apply</button>
                    <button class="btn" @click=${() => this.edit(s)}>Edit</button>
                    <button class="btn btn-danger" @click=${() => this.erase(s.id)}>✕</button>
                  </div>
                </div>
              `)}
        </div>
      </div>
    `;
  }

  private deviceName(id: string): string {
    return this.devices.find(d => d.deviceId === id)?.name ?? id;
  }
}

declare global { interface HTMLElementTagNameMap { "st-zones": StZones; } }
