import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker, recordArt, isImageUrl } from "../store.js";
import { api, type Device, type RadioStation } from "../api.js";

type SubTab = "radio" | "nas";

interface NasFrame {
  uuid: string;
  serverName: string;
  objectId: string;
  title: string;
  items: { id: string; parentId: string; title: string; isContainer: boolean; url?: string; mime?: string }[];
}

@customElement("st-browse")
export class StBrowse extends LitElement {
  @state() private sub: SubTab = "radio";
  @state() private query = "";
  @state() private results: RadioStation[] = [];
  @state() private busy = false;
  @state() private servers: { uuid: string; name: string }[] = [];
  @state() private nasStack: NasFrame[] = [];
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;

  static styles = css`
    :host { display: block; height: 100%; }
    .scroll { overflow-y: auto; padding: 16px; padding-bottom: 96px; height: 100%; }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tabs button {
      flex: 1; padding: 10px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--bg-elevated); color: var(--fg-muted);
    }
    .tabs button.active { background: var(--accent); color: #0a1224; border-color: transparent; }
    .station, .nas-row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px; background: var(--bg-elevated); border-radius: 12px; margin-bottom: 8px;
    }
    .favicon { width: 36px; height: 36px; border-radius: 8px; background: var(--accent-strong); display: grid; place-items: center; flex-shrink: 0; }
    .favicon img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .station .meta { flex: 1; min-width: 0; }
    .station .name { font-weight: 600; }
    .station .info { color: var(--fg-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crumbs { font-size: 12px; color: var(--fg-muted); margin-bottom: 8px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; }));
    this.refreshServers();
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private async refreshServers() {
    try { this.servers = await api.nasServers(); } catch (e) { console.warn(e); }
  }

  private async search() {
    if (!this.query.trim()) return;
    this.busy = true;
    try {
      this.results = await api.radioSearch({ name: this.query, limit: 30 });
    } finally { this.busy = false; }
  }

  private async playStation(s: RadioStation) {
    const speakerId = $selectedSpeaker.get();
    console.log("[browse] play station", s.name, "live selectedSpeaker:", speakerId);
    if (!speakerId) return;
    recordArt(speakerId, s.favicon || null);
    await api.radioPlay(s.uuid, { speakerId });
  }

  private async savePresetFromStation(s: RadioStation) {
    if (!this.selected) return;
    await api.savePreset({
      label: s.name,
      kind: "radio",
      speaker_id: this.selected,
      slot: null,
      payload: JSON.stringify({ uuid: s.uuid }),
      artwork_url: s.favicon || null,
    });
    alert("Saved as a shared preset.");
  }

  private async openNasServer(uuid: string, name: string) {
    const items = await api.nasBrowse(uuid, "0");
    this.nasStack = [{ uuid, serverName: name, objectId: "0", title: name, items }];
  }

  private async openContainer(it: NasFrame["items"][number]) {
    const top = this.nasStack[this.nasStack.length - 1];
    if (!top) return;
    const items = await api.nasBrowse(top.uuid, it.id);
    this.nasStack = [...this.nasStack, { uuid: top.uuid, serverName: top.serverName, objectId: it.id, title: it.title, items }];
  }

  private back() {
    if (this.nasStack.length > 1) this.nasStack = this.nasStack.slice(0, -1);
    else this.nasStack = [];
  }

  private async playNas(it: NasFrame["items"][number]) {
    if (!it.url || !it.mime || !this.selected) return;
    await api.nasPlay({ url: it.url, mime: it.mime, title: it.title, speakerId: this.selected });
  }

  render() {
    const top = this.nasStack[this.nasStack.length - 1];
    return html`
      <div class="scroll">
        <h1>Browse</h1>
        <div class="tabs">
          <button class=${this.sub === "radio" ? "active" : ""} @click=${() => (this.sub = "radio")}>Radio</button>
          <button class=${this.sub === "nas" ? "active" : ""} @click=${() => (this.sub = "nas")}>NAS</button>
        </div>

        ${this.sub === "radio" ? html`
          <div class="row">
            <input type="text" placeholder="Search stations…" .value=${this.query}
                   @keyup=${(e: KeyboardEvent) => e.key === "Enter" && this.search()}
                   @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
            <button class="btn btn-primary" @click=${() => this.search()} ?disabled=${this.busy}>Go</button>
          </div>
          <div style="height:12px"></div>
          ${this.results.map(s => html`
            <div class="station">
              <div class="favicon">${isImageUrl(s.favicon) ? html`<img src=${s.favicon} alt="" />` : html`<span>📻</span>`}</div>
              <div class="meta" @click=${() => this.playStation(s)}>
                <div class="name">${s.name}</div>
                <div class="info">${s.country} · ${s.codec || "?"} · ${s.bitrate || "?"} kbps · ${s.tags}</div>
              </div>
              <button class="btn" @click=${() => this.savePresetFromStation(s)}>Save</button>
              <button class="btn btn-primary" @click=${() => this.playStation(s)}>Play</button>
            </div>
          `)}
        ` : html`
          ${this.nasStack.length === 0 ? html`
            <h3>Servers</h3>
            ${this.servers.length === 0
              ? html`
                  <div class="muted">No DLNA / UPnP servers visible.</div>
                  <div style="height: 8px"></div>
                  <button class="btn" @click=${() => api.nasWake().catch(() => alert("Configure SOUNDTIDE_NAS_WOL_MAC on the Pi first."))}>Wake NAS</button>
                `
              : this.servers.map(s => html`
                  <button class="btn" @click=${() => this.openNasServer(s.uuid, s.name)}>${s.name}</button>
                `)}
          ` : html`
            <div class="crumbs">${this.nasStack.map(f => f.title).join(" / ")}</div>
            <button class="btn" @click=${() => this.back()}>↶ Back</button>
            <div style="height: 8px"></div>
            ${top!.items.map(it => html`
              <div class="nas-row">
                <span class="favicon"><span>${it.isContainer ? "📁" : "♪"}</span></span>
                <div class="meta" style="flex:1">
                  <div>${it.title}</div>
                  <div class="muted" style="font-size:12px;">${it.mime ?? ""}</div>
                </div>
                ${it.isContainer
                  ? html`<button class="btn" @click=${() => this.openContainer(it)}>Open</button>`
                  : html`<button class="btn btn-primary" @click=${() => this.playNas(it)}>Play</button>`}
              </div>
            `)}
          `}
        `}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-browse": StBrowse; } }
