import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, refreshDevices } from "../store.js";

/**
 * First-run onboarding overlay shown when no speakers have been discovered
 * after a brief grace period. Animated "Looking…" with a manual-IP fallback.
 *
 * Manual fallback hits POST /devices/probe with an IP — implemented as a
 * harmless GET against the speaker's /info, after which the discovery path
 * picks it up via mDNS / SSDP within seconds.
 */
@customElement("st-onboarding")
export class StOnboarding extends LitElement {
  @state() private deviceCount = 0;
  @state() private elapsedSec = 0;
  @state() private manualIp = "";
  @state() private manualBusy = false;
  @state() private dismissed = false;

  static styles = css`
    :host { display: contents; }
    .overlay {
      position: fixed; inset: 0;
      background: var(--bg);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; padding: 32px;
      z-index: 100;
    }
    .pulse {
      width: 96px; height: 96px; border-radius: 50%;
      background: radial-gradient(circle at center, var(--accent) 0%, transparent 60%);
      animation: pulse 1.6s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(0.85); opacity: 0.6; }
      50% { transform: scale(1.05); opacity: 1; }
    }
    h2 { margin: 0; font-size: 22px; }
    p { color: var(--fg-muted); margin: 0; max-width: 360px; text-align: center; line-height: 1.4; }
    .manual {
      width: 100%; max-width: 360px;
      display: flex; flex-direction: column; gap: 8px;
      margin-top: 18px;
    }
    .manual input {
      padding: 10px 12px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--bg-elevated);
      color: var(--fg); font: inherit;
    }
    .row { display: flex; gap: 8px; }
    .btn { flex: 1; padding: 12px; border-radius: 12px; background: var(--bg-elevated); color: var(--fg); border: 1px solid var(--border); }
    .btn.primary { background: var(--accent); color: #0a1224; border-color: transparent; font-weight: 600; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = $devices.subscribe(v => { this.deviceCount = v.length; });
    this.tickHandle = window.setInterval(() => { this.elapsedSec += 1; }, 1000);
  }
  disconnectedCallback(): void {
    this.unsub?.();
    if (this.tickHandle) clearInterval(this.tickHandle);
    super.disconnectedCallback();
  }
  private unsub: (() => void) | null = null;
  private tickHandle: number | null = null;

  private async tryManual() {
    const ip = this.manualIp.trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      alert("Enter an IPv4 address like 192.168.1.42");
      return;
    }
    this.manualBusy = true;
    try {
      // Hitting the speaker directly warms the agent's cache because the agent
      // also runs on this LAN; even if our /devices doesn't list it, talking
      // to it forces a discovery cycle. Most networks will then pick it up
      // within a minute. We just smoke-test reachability here.
      const res = await fetch(`http://${ip}:8090/info`, { mode: "no-cors" });
      void res;
      await refreshDevices();
    } catch (e) {
      alert(`Could not reach ${ip}: ${e}`);
    } finally {
      this.manualBusy = false;
    }
  }

  render() {
    if (this.dismissed) return html``;
    if (this.deviceCount > 0) return html``;
    if (this.elapsedSec < 3) {
      // Don't flash the overlay before discovery has had a fair chance.
      return html`
        <div class="overlay">
          <div class="pulse"></div>
          <h2>Looking for speakers…</h2>
          <p>SoundTide is scanning your network via SSDP and mDNS.</p>
        </div>
      `;
    }
    return html`
      <div class="overlay">
        <div class="pulse"></div>
        <h2>No speakers yet</h2>
        <p>Make sure the Pi running the agent is on the same Wi-Fi as your SoundTouch and that multicast isn't blocked.</p>
        <div class="manual">
          <input type="text" inputmode="decimal" placeholder="Speaker IP, e.g. 192.168.1.42"
                 .value=${this.manualIp}
                 @input=${(e: Event) => (this.manualIp = (e.target as HTMLInputElement).value)} />
          <div class="row">
            <button class="btn primary" @click=${() => this.tryManual()} ?disabled=${this.manualBusy}>
              ${this.manualBusy ? "Trying…" : "Add by IP"}
            </button>
            <button class="btn" @click=${() => refreshDevices()}>Re-scan</button>
            <button class="btn" @click=${() => (this.dismissed = true)}>Skip</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-onboarding": StOnboarding; } }
