import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $theme, refreshDevices, type Theme } from "../store.js";
import { api, type Device } from "../api.js";

@customElement("st-settings")
export class StSettings extends LitElement {
  @state() private devices: Device[] = [];
  @state() private token = localStorage.getItem("soundtide.token") ?? "";
  @state() private nasUrl = "";
  @state() private msg = "";
  @state() private theme: Theme = $theme.get();
  @state() private rescanning = false;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    .device {
      display: flex; align-items: center; gap: 10px; padding: 12px; background: var(--bg-elevated); border-radius: 12px; margin-bottom: 8px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); }
    .dot.off { background: var(--danger); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($theme.subscribe(v => { this.theme = v; }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private save() {
    api.setToken(this.token.trim() || null);
    this.msg = "Saved.";
    setTimeout(() => (this.msg = ""), 1500);
  }

  private async addNas() {
    if (!this.nasUrl.trim()) return;
    try {
      await api.nasAdd(this.nasUrl.trim());
      this.nasUrl = "";
      this.msg = "Added.";
    } catch (e) { this.msg = String(e); }
  }

  private async rename(id: string, current: string) {
    const name = prompt("New speaker name", current);
    if (!name) return;
    try { await api.rename(id, name); await refreshDevices(); } catch (e) { alert(String(e)); }
  }

  /** Force a real LAN scan + probe of every known IP, not just a re-pull of
   * the local cache. Speakers that just came back online appear here within
   * a few seconds. */
  private async rescan() {
    this.rescanning = true;
    this.msg = "Scanning LAN…";
    try {
      const r = await api.rescan();
      await refreshDevices();
      this.msg = `Probed ${r.knownProbed} known speaker${r.knownProbed === 1 ? "" : "s"} · M-SEARCH ${r.ssdpFired ? "fired" : "skipped"}.`;
    } catch (e) {
      this.msg = `Scan failed: ${e}`;
    } finally {
      this.rescanning = false;
      setTimeout(() => (this.msg = ""), 4000);
    }
  }

  render() {
    return html`
      <div class="scroll">
        <h1>Settings</h1>

        <h2>Speakers</h2>
        ${this.devices.length === 0
          ? html`<div class="muted">No speakers discovered yet.</div>`
          : this.devices.map(d => html`
              <div class="device">
                <span class="dot ${d.online ? "" : "off"}"></span>
                <div style="flex:1">
                  <div>${d.name}</div>
                  <div class="muted" style="font-size:12px;">${d.type} · ${d.ip} · ${d.deviceId}</div>
                </div>
                <button class="btn" @click=${() => this.rename(d.deviceId, d.name)}>Rename</button>
              </div>
            `)}
        <button class="btn btn-primary" ?disabled=${this.rescanning}
                @click=${() => this.rescan()}>
          ${this.rescanning ? "Scanning…" : "Rescan LAN"}
        </button>

        <h2>Off-LAN access</h2>
        <p class="muted">Paste the household token configured on the Pi (and on the Worker secret). Only needed when accessing the app from outside your home network.</p>
        <div class="row">
          <input type="text" placeholder="household token" .value=${this.token}
                 @input=${(e: Event) => (this.token = (e.target as HTMLInputElement).value)} />
          <button class="btn btn-primary" @click=${() => this.save()}>Save</button>
        </div>

        <h2>Theme</h2>
        <p class="muted">Auto follows your device's light/dark setting.</p>
        <div class="row" style="gap: 6px;">
          ${(["auto","dark","light"] as Theme[]).map(t => html`
            <button class="btn ${this.theme === t ? "btn-primary" : ""}" style="flex:1"
                    @click=${() => $theme.set(t)}>${t[0]?.toUpperCase()}${t.slice(1)}</button>
          `)}
        </div>

        <h2>NAS / DLNA</h2>
        <p class="muted">If your Synology isn't picked up automatically, paste its UPnP description URL (often <code>http://&lt;nas-ip&gt;:50001/desc/Server.xml</code>).</p>
        <div class="row">
          <input type="text" placeholder="http://… /Server.xml" .value=${this.nasUrl}
                 @input=${(e: Event) => (this.nasUrl = (e.target as HTMLInputElement).value)} />
          <button class="btn" @click=${() => this.addNas()}>Add</button>
        </div>

        <div style="height: 16px"></div>
        ${this.msg ? html`<div class="card">${this.msg}</div>` : ""}

        <h2>About</h2>
        <p class="muted">SoundTide v0.1 — local-first PWA for Bose SoundTouch 10 / 20 / 30. Bose and SoundTouch are trademarks of Bose Corporation; this project is not affiliated with or endorsed by Bose.</p>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-settings": StSettings; } }
