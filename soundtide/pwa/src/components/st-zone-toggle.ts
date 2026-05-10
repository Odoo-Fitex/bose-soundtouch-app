import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $devices, $selectedSpeaker, $zones, refreshState } from "../store.js";
import { api, type Device, type Zone } from "../api.js";

/**
 * Inline control on Now Playing: shows the current zone composition as a row
 * of pills (master + members), plus an "+ Add" pill that opens a member
 * picker sheet. Tapping a speaker in the picker toggles its membership in
 * real time — same UX as Sonos's "Group" button.
 *
 * The selected speaker is implicitly the master. If the selected speaker is
 * itself a slave in someone else's zone, we offer to ungroup first.
 */
@customElement("st-zone-toggle")
export class StZoneToggle extends LitElement {
  @state() private devices: Device[] = [];
  @state() private selected: string | null = null;
  @state() private zones: Record<string, Zone> = {};
  @state() private picker = false;
  @state() private busy = "";

  static styles = css`
    :host { display: block; margin: 12px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .pill {
      padding: 6px 10px; border-radius: 999px; font-size: 12px;
      background: var(--bg-elevated); border: 1px solid var(--border);
      color: var(--fg);
      display: inline-flex; align-items: center; gap: 6px;
    }
    .pill.master { border-color: var(--accent); }
    .pill.add { border-style: dashed; color: var(--fg-muted); }
    .pill.add:active { background: var(--accent-strong); }
    .small { font-size: 10px; padding: 2px 6px; border-radius: 999px; background: var(--accent-strong); color: var(--fg); }

    .modal {
      position: fixed; inset: 0; z-index: 70;
      background: rgba(8, 12, 22, 0.6);
      display: flex; align-items: flex-end; justify-content: center;
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
    p { color: var(--fg-muted); margin: 0 0 14px; font-size: 13px; }
    .opt {
      display: flex; align-items: center; gap: 10px; padding: 12px;
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 12px; margin-bottom: 6px; width: 100%;
      color: var(--fg); font: inherit; text-align: left;
    }
    .opt[disabled] { opacity: 0.5; cursor: not-allowed; }
    .opt .name { flex: 1; font-weight: 600; }
    .opt .toggle {
      padding: 6px 10px; border-radius: 999px;
      background: var(--bg-elevated); border: 1px solid var(--border);
      font-size: 12px; color: var(--fg-muted);
    }
    .opt .toggle.on { background: var(--accent); color: #0a1224; border-color: transparent; }
    .close { width: 100%; padding: 12px; border-radius: 12px; background: var(--bg); border: 1px solid var(--border); color: var(--fg); margin-top: 6px; }
    .danger { color: var(--danger); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($devices.subscribe(v => { this.devices = [...v]; }));
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; }));
    this.unsub.push($zones.subscribe(v => { this.zones = { ...v }; }));
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  /** Returns the current zone the selected speaker is in (or a synthetic solo).
   *
   * The store keeps one zone view per speaker, and they can disagree
   * transiently after a setZone call: the master and the new slave see
   * the full membership immediately, but pre-existing slaves keep showing
   * the old smaller list until they next emit a zoneUpdated event. Without
   * this defence, a tap on "+ Add room" for a third speaker is silently
   * swallowed because we render an old view that doesn't include slot 3.
   *
   * Resolution rule: prefer the zone keyed by the master's own deviceId
   * (the source of truth on this firmware), then fall back to the longest
   * member list, then to any view that mentions us at all. */
  private currentZone(): { masterId: string | null; memberIds: string[] } {
    if (!this.selected) return { masterId: null, memberIds: [] };

    const candidates = Object.entries(this.zones)
      .filter(([, z]) => z?.master)
      .filter(([, z]) => {
        const ids = [z.master!, ...z.members.map(m => m.deviceId)];
        return ids.some(id => id.toUpperCase() === this.selected!.toUpperCase());
      });
    if (candidates.length === 0) return { masterId: this.selected, memberIds: [] };

    candidates.sort(([keyA, a], [keyB, b]) => {
      // Master's own view first.
      const aIsMaster = keyA.toUpperCase() === a.master!.toUpperCase();
      const bIsMaster = keyB.toUpperCase() === b.master!.toUpperCase();
      if (aIsMaster !== bIsMaster) return aIsMaster ? -1 : 1;
      // Longest member list wins ties.
      return b.members.length - a.members.length;
    });
    const [, z] = candidates[0]!;
    return {
      masterId: z.master,
      memberIds: z.members
        .map(m => m.deviceId)
        .filter(id => id.toUpperCase() !== z.master!.toUpperCase()),
    };
  }

  private dev(id: string): Device | undefined {
    return this.devices.find(d => d.deviceId === id);
  }

  private async toggle(speakerId: string) {
    if (!this.selected) return;
    this.busy = speakerId;
    try {
      const z = this.currentZone();
      const masterId = z.masterId ?? this.selected;
      const isMember = z.memberIds.includes(speakerId) || speakerId === masterId;

      if (speakerId === masterId) {
        // The user tapped the master itself — interpret as "ungroup the
        // whole zone".
        await api.zoneClear(masterId);
      } else if (isMember) {
        await api.zoneRemove(masterId, speakerId);
      } else {
        await api.zoneAdd(masterId, speakerId);
      }

      // Reconcile zone state from every speaker's truth, not just master and
      // the toggled one. Existing slaves don't always emit a zoneUpdated event
      // promptly after setZone, so without this their cached zone view stays
      // stale and currentZone() can return the wrong list — which manifests as
      // "+ Add room" doing nothing visible for the third speaker.
      setTimeout(() => {
        // Refresh master + new speaker first (these are guaranteed to have
        // the freshest view), then everyone else, so a transient stale read
        // doesn't repopulate $zones[*] before we can override it.
        refreshState(masterId);
        refreshState(speakerId);
        const others = this.devices
          .map(d => d.deviceId)
          .filter(id => id !== masterId && id !== speakerId);
        for (const id of others) refreshState(id);
      }, 400);
    } catch (e) {
      console.warn("zone toggle failed", e);
      alert(`Group action failed: ${e}`);
    } finally {
      this.busy = "";
    }
  }

  render() {
    if (!this.selected || this.devices.length <= 1) return html``;
    const z = this.currentZone();
    const master = (z.masterId ? this.dev(z.masterId) : null) ?? null;
    const members = z.memberIds.map(id => this.dev(id)).filter((d): d is Device => !!d);

    return html`
      <div class="row">
        ${master ? html`
          <span class="pill master">
            ${master.name}
            <span class="small">master</span>
          </span>` : ""}
        ${members.map(m => html`<span class="pill">${m.name}</span>`)}
        <button class="pill add" @click=${() => (this.picker = true)}>＋ Add room</button>
      </div>
      ${this.picker ? this.renderPicker(master, members) : ""}
    `;
  }

  private renderPicker(master: Device | null, members: Device[]) {
    const masterId = master?.deviceId ?? this.selected!;
    const memberIds = new Set(members.map(m => m.deviceId));
    return html`
      <div class="modal" @click=${(e: Event) => { if (e.target === e.currentTarget) this.picker = false; }}>
        <div class="sheet">
          <h2>Group with…</h2>
          <p>Tap a speaker to add or remove it from this zone. They all play in sync.</p>
          ${this.devices.map(d => {
            const isSelf = d.deviceId === masterId;
            const isMember = memberIds.has(d.deviceId);
            const role = isSelf ? "master" : (isMember ? "in" : "out");
            // Only disable while a request is in flight for that exact speaker.
            // The "online" flag is best-effort — let the agent be the source of
            // truth, otherwise a freshly powered-on speaker stays grey for a
            // minute even though it's reachable.
            return html`
              <button class="opt" ?disabled=${this.busy === d.deviceId}
                      @click=${() => this.toggle(d.deviceId)}>
                <span class="name">${d.name}${!d.online ? html` <span style="font-size:11px;color:var(--fg-muted)">(offline?)</span>` : ""}</span>
                <span class="toggle ${role !== "out" ? "on" : ""}">
                  ${role === "master" ? "Master" : (role === "in" ? "In group" : "Add")}
                </span>
              </button>
            `;
          })}
          ${master && members.length > 0 ? html`
            <button class="opt danger" @click=${() => { this.toggle(masterId); }}>
              <span class="name">Ungroup all</span>
              <span class="toggle">Clear</span>
            </button>
          ` : ""}
          <button class="close" @click=${() => (this.picker = false)}>Done</button>
        </div>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-zone-toggle": StZoneToggle; } }
