import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $sleepAt } from "../store.js";

const PRESETS = [15, 30, 60, 90];

/** Bottom-sheet modal to set or cancel the sleep timer. */
@customElement("st-sleep-timer")
export class StSleepTimer extends LitElement {
  @state() private at: number | null = null;

  static styles = css`
    :host {
      position: fixed; inset: 0;
      background: rgba(8, 12, 22, 0.6);
      display: flex; align-items: flex-end; justify-content: center;
      z-index: 50;
      animation: fade 160ms ease-out;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .sheet {
      width: 100%; max-width: 480px;
      background: var(--bg-elevated);
      border-top-left-radius: 18px; border-top-right-radius: 18px;
      padding: 18px 18px calc(18px + env(safe-area-inset-bottom));
      box-shadow: 0 -10px 30px rgba(0,0,0,0.4);
      animation: slide 200ms ease-out;
    }
    @keyframes slide { from { transform: translateY(100%); } to { transform: translateY(0); } }
    h2 { margin: 0 0 4px; font-size: 18px; }
    p { color: var(--fg-muted); margin: 0 0 14px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
    .preset {
      padding: 14px 0; border-radius: 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--fg); font-weight: 600;
    }
    .preset.active { background: var(--accent); color: #0a1224; border-color: transparent; }
    .row { display: flex; gap: 8px; }
    .btn {
      flex: 1; padding: 12px; border-radius: 12px;
      background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    }
    .btn.danger { color: var(--danger); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = $sleepAt.subscribe(v => { this.at = v; });
  }
  disconnectedCallback(): void { this.unsub?.(); super.disconnectedCallback(); }
  private unsub: (() => void) | null = null;

  private set(minutes: number) {
    $sleepAt.set(Date.now() + minutes * 60_000);
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private cancel() {
    $sleepAt.set(null);
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  private close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }

  render() {
    const minutesLeft = this.at ? Math.ceil((this.at - Date.now()) / 60_000) : null;
    return html`
      <div @click=${this.close} style="position:absolute;inset:0;"></div>
      <div class="sheet">
        <h2>Sleep timer</h2>
        <p>${this.at ? `Currently set for ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}.` :
                       "Pause and power off after a delay."}</p>
        <div class="grid">
          ${PRESETS.map(m => {
            const active = !!this.at && this.at - Date.now() > (m - 1) * 60_000 && this.at - Date.now() <= m * 60_000;
            return html`<button class="preset ${active ? "active" : ""}" @click=${() => this.set(m)}>${m} min</button>`;
          })}
        </div>
        <div class="row">
          ${this.at ? html`<button class="btn danger" @click=${this.cancel}>Cancel timer</button>` : ""}
          <button class="btn" @click=${this.close}>Close</button>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-sleep-timer": StSleepTimer; } }
