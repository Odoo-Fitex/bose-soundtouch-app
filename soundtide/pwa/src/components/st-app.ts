import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $tab, type Tab } from "../store.js";
import "./st-now-playing.js";
import "./st-presets.js";
import "./st-zones.js";
import "./st-browse.js";
import "./st-schedules.js";
import "./st-settings.js";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "now",      label: "Now",       icon: "▶" },
  { id: "presets",  label: "Presets",   icon: "★" },
  { id: "zones",    label: "Zones",     icon: "⊞" },
  { id: "browse",   label: "Browse",    icon: "☰" },
  { id: "schedule", label: "Schedule",  icon: "⏰" },
  { id: "settings", label: "Settings",  icon: "⚙" },
];

@customElement("st-app")
export class StApp extends LitElement {
  @state() private tab: Tab = "now";

  static styles = css`
    :host {
      display: grid;
      grid-template-rows: 1fr auto;
      height: 100dvh;
      background: var(--bg);
      color: var(--fg);
    }
    main {
      overflow: hidden;
      position: relative;
    }
    nav {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      border-top: 1px solid var(--border);
      background: var(--bg-elevated);
      padding-bottom: env(safe-area-inset-bottom);
    }
    nav button {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 10px 4px;
      gap: 4px;
      color: var(--fg-muted);
      font-size: 11px;
      min-height: 64px;
    }
    nav button.active { color: var(--accent); }
    nav button .icon { font-size: 18px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.tab = $tab.get();
    this._unsub = $tab.subscribe((t) => { this.tab = t; });
  }
  disconnectedCallback(): void { this._unsub?.(); super.disconnectedCallback(); }
  private _unsub: (() => void) | null = null;

  render() {
    return html`
      <main>
        ${this.tab === "now"      ? html`<st-now-playing></st-now-playing>` : ""}
        ${this.tab === "presets"  ? html`<st-presets></st-presets>` : ""}
        ${this.tab === "zones"    ? html`<st-zones></st-zones>` : ""}
        ${this.tab === "browse"   ? html`<st-browse></st-browse>` : ""}
        ${this.tab === "schedule" ? html`<st-schedules></st-schedules>` : ""}
        ${this.tab === "settings" ? html`<st-settings></st-settings>` : ""}
      </main>
      <nav>
        ${TABS.map((t) => html`
          <button class=${t.id === this.tab ? "active" : ""} @click=${() => $tab.set(t.id)}>
            <span class="icon">${t.icon}</span>${t.label}
          </button>
        `)}
      </nav>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-app": StApp; } }
