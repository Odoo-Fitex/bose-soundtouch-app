import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $selectedSpeaker, recordArt, isImageUrl } from "../store.js";
import { api, type Preset, type RadioStation } from "../api.js";

interface Hit {
  kind: "preset" | "radio";
  id: string;       // preset id, or radio uuid
  label: string;
  sub?: string;
  art?: string | null;
}

/**
 * Inline search bar with a result dropdown. Hits both saved presets and
 * radio-browser.info in parallel; tap a hit to play it on the selected speaker.
 */
@customElement("st-search")
export class StSearch extends LitElement {
  @state() private q = "";
  @state() private busy = false;
  @state() private hits: Hit[] = [];
  @state() private selected: string | null = null;
  private timer: number | null = null;

  static styles = css`
    :host { display: block; position: relative; }
    .input {
      display: flex; align-items: center;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 999px; padding: 4px 4px 4px 14px;
    }
    input {
      flex: 1;
      background: transparent; border: 0; color: var(--fg);
      padding: 10px 4px; min-height: 36px; font: inherit;
      outline: none;
    }
    button.go {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--accent); color: #0a1224;
    }
    .dropdown {
      position: absolute; left: 0; right: 0; top: 100%;
      margin-top: 8px; padding: 6px;
      background: var(--bg-elevated); border: 1px solid var(--border);
      border-radius: 14px; max-height: 360px; overflow-y: auto;
      box-shadow: 0 12px 30px rgba(0,0,0,0.4);
      z-index: 10;
    }
    .hit {
      width: 100%;
      display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px;
      background: transparent; border: 0; color: inherit; text-align: left;
      cursor: pointer;
    }
    .hit:hover, .hit:focus { background: var(--bg); }
    .hit:active { background: var(--accent-strong); }
    .icon { width: 32px; height: 32px; border-radius: 8px; background: var(--accent-strong); display: grid; place-items: center; flex-shrink: 0; font-size: 14px; }
    .icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .meta { flex: 1; min-width: 0; }
    .label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { color: var(--fg-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kind { font-size: 10px; padding: 2px 6px; border-radius: 999px; background: var(--accent-strong); color: var(--fg); text-transform: uppercase; }
    .empty { padding: 12px; color: var(--fg-muted); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = $selectedSpeaker.subscribe(v => { this.selected = v; });
  }
  disconnectedCallback(): void { this.unsub?.(); super.disconnectedCallback(); }
  private unsub: (() => void) | null = null;

  private onInput(e: Event) {
    this.q = (e.target as HTMLInputElement).value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.search(), 300);
  }

  private async search() {
    const q = this.q.trim();
    if (!q) { this.hits = []; return; }
    this.busy = true;
    try {
      const [presets, stations] = await Promise.all([
        api.presets().catch(() => [] as Preset[]),
        api.radioSearch({ name: q, limit: 8 }).catch(() => [] as RadioStation[]),
      ]);
      const lq = q.toLowerCase();
      const presetHits: Hit[] = presets
        .filter(p => p.label.toLowerCase().includes(lq))
        .slice(0, 4)
        .map(p => ({ kind: "preset", id: p.id, label: p.label, sub: p.kind, art: p.artwork_url ?? undefined }));
      const stationHits: Hit[] = stations.map(s => ({
        kind: "radio", id: s.uuid, label: s.name,
        sub: [s.country, s.codec, `${s.bitrate} kbps`].filter(Boolean).join(" · "),
        art: s.favicon || undefined,
      }));
      this.hits = [...presetHits, ...stationHits];
    } finally {
      this.busy = false;
    }
  }

  private async play(h: Hit) {
    // Read the current selection AT CLICK TIME from the store, not the
    // subscription-cached field — the cached value can lag if the user
    // tapped a different room pill milliseconds before tapping the result.
    const speakerId = $selectedSpeaker.get();
    console.log("[search] play hit", h, "live selectedSpeaker:", speakerId);
    // Close the dropdown immediately so the UI never feels stuck.
    this.q = "";
    this.hits = [];
    try {
      if (h.kind === "preset") {
        // Override the preset's stored speaker_id with the live selection so
        // the user's room-strip choice always wins. Without this, presets
        // play on whichever room they were saved against — confusing UX.
        await api.playPreset(h.id, speakerId ? { speakerId } : {});
        if (speakerId && h.art) recordArt(speakerId, h.art);
      } else if (h.kind === "radio") {
        if (!speakerId) {
          alert("Pick a speaker first (top of the screen).");
          return;
        }
        // Cache the favicon so Now Playing has art even though the speaker
        // doesn't report any when streaming via DLNA UPnP.
        recordArt(speakerId, h.art ?? null);
        await api.radioPlay(h.id, { speakerId });
      }
    } catch (e) {
      console.warn("search play failed", e);
      alert(`Play failed: ${e}`);
    }
  }

  render() {
    return html`
      <div class="input">
        <input type="search" placeholder="Search radio, presets…" .value=${this.q}
               @input=${(e: Event) => this.onInput(e)}
               @keyup=${(e: KeyboardEvent) => e.key === "Enter" && this.search()} />
        <button class="go" @click=${() => this.search()} ?disabled=${this.busy}>${this.busy ? "…" : "→"}</button>
      </div>
      ${this.q.trim() && this.hits.length > 0 ? html`
        <div class="dropdown">
          ${this.hits.map(h => html`
            <button class="hit" type="button" @click=${(e: Event) => { e.stopPropagation(); this.play(h); }}>
              <span class="icon">${isImageUrl(h.art) ? html`<img src=${h.art} alt="" />` : (h.kind === "radio" ? "📻" : "★")}</span>
              <div class="meta">
                <div class="label">${h.label}</div>
                <div class="sub">${h.sub ?? ""}</div>
              </div>
              <span class="kind">${h.kind}</span>
            </button>
          `)}
        </div>
      ` : ""}
      ${this.q.trim() && !this.busy && this.hits.length === 0 ? html`
        <div class="dropdown"><div class="empty">No results.</div></div>
      ` : ""}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-search": StSearch; } }
