import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { $selectedSpeaker, recordArt, isImageUrl } from "../store.js";
import { api, type Preset } from "../api.js";

/**
 * A pinned favourites grid. Shown on Now Playing as the empty-state when no
 * audio is playing. Tap a tile to start that preset on the currently selected
 * speaker.
 *
 * Layout notes:
 *   • Tiles are compact rows of [art / label / play] rather than huge square
 *     panels. The previous square-tile layout (aspect 1.4:1, 2 cols) ate the
 *     entire viewport on a wide desktop browser.
 *   • Each tile shows the saved artwork (radio favicon, etc.) as a small
 *     thumbnail; falls back to a kind-specific glyph when no image.
 *   • A tiny ✕ button lives at the right of each tile and deletes the
 *     preset after a confirm — so saved favourites can be cleaned up
 *     without round-tripping to the Presets tab.
 */
@customElement("st-favourites")
export class StFavourites extends LitElement {
  @state() private presets: Preset[] = [];
  @state() private busy = "";
  @state() private selected: string | null = null;

  static styles = css`
    :host { display: block; }
    h3 {
      margin: 0 0 10px; color: var(--fg-muted); font-size: 13px;
      text-transform: uppercase; letter-spacing: 0.05em;
      display: flex; align-items: center; justify-content: space-between;
    }
    /* Compact list on phones, two columns on tablet/desktop. Auto-rows
       keep tiles short (~64px) instead of the previous square layout. */
    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    @media (min-width: 720px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (min-width: 1100px) {
      .grid { grid-template-columns: repeat(3, 1fr); }
    }

    .tile {
      display: grid;
      grid-template-columns: 44px 1fr auto auto;
      gap: 10px; align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--bg-elevated);
      color: var(--fg);
      text-align: left;
      cursor: pointer;
      transition: transform 80ms ease-out, background-color 120ms ease-out;
      /* Reset element-level button defaults — the tile is rendered as a
         <div role="button"> instead of a real <button>, because nesting a
         delete <button> inside a <button> would be invalid HTML and the
         browser silently splits it into two siblings (which produced the
         enormous stranded ✕ cells we saw in the favourites grid). */
      font: inherit;
      user-select: none;
    }
    .tile:active { transform: scale(0.98); }
    .tile.empty { color: var(--fg-muted); border-style: dashed; cursor: default; }
    .tile .art {
      width: 44px; height: 44px; border-radius: 8px;
      background: var(--accent-strong);
      display: grid; place-items: center;
      flex-shrink: 0; overflow: hidden;
      font-size: 18px;
    }
    .tile .art img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .tile .meta { min-width: 0; }
    .tile .label { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile .kind { color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .tile .play-hint { color: var(--fg-muted); font-size: 11px; padding: 0 6px; }
    .tile .del {
      background: transparent; border: 0; color: var(--fg-muted);
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      font-size: 16px; line-height: 1;
    }
    .tile .del:hover { background: var(--bg); color: var(--danger); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub.push($selectedSpeaker.subscribe(v => { this.selected = v; this.load(); }));
    this.load();
  }
  disconnectedCallback(): void { this.unsub.forEach(f => f()); super.disconnectedCallback(); }
  private unsub: (() => void)[] = [];

  private async load() {
    try {
      const all = await api.presets();
      // Sort: bound-to-this-speaker slots 1..6 first, then shared, capped at 12
      // (was 6 — with the new compact layout we comfortably show more).
      const sel = this.selected;
      const score = (p: Preset) => {
        if (sel && p.speaker_id === sel && p.slot != null) return p.slot;
        if (!p.speaker_id || p.slot == null) return 100 + (p.label?.length ?? 0);
        return 200;
      };
      this.presets = [...all].sort((a, b) => score(a) - score(b)).slice(0, 12);
    } catch (e) {
      console.warn("favourites load failed", e);
    }
  }

  private async play(id: string) {
    // Read the live store at click time — see the comment in st-search.play()
    // for why the cached `this.selected` is unsafe here.
    const speakerId = $selectedSpeaker.get();
    const preset = this.presets.find(p => p.id === id);
    console.log("[favourites] play", id, "live selectedSpeaker:", speakerId, "preset.speaker_id:", preset?.speaker_id);
    this.busy = id;
    try {
      await api.playPreset(id, speakerId ? { speakerId } : {});
      if (preset?.artwork_url && speakerId) {
        recordArt(speakerId, preset.artwork_url);
      }
    } catch (e) {
      console.warn("favourites play failed", e);
      alert(`Play failed: ${e}`);
    } finally {
      this.busy = "";
    }
  }

  private async erase(p: Preset, ev: Event) {
    // Stop the parent tile from also firing play() — clicks on the ✕ should
    // only ever delete, never start playback on the way down.
    ev.stopPropagation();
    if (!confirm(`Delete preset "${p.label}"?`)) return;
    try {
      await api.deletePreset(p.id);
      await this.load();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  /** Choose the right glyph when no artwork is saved. Radio gets a radio
   * icon, NAS/podcast/AUX get reasonable defaults. */
  private fallbackGlyph(p: Preset): string {
    switch (p.kind) {
      case "radio": return "📻";
      case "nas": return "🎵";
      case "podcast": return "🎙️";
      case "aux": return "🎧";
      case "spotify_uri": return "♪";
      default: return "★";
    }
  }

  render() {
    if (this.presets.length === 0) {
      return html`
        <h3><span>Favourites</span></h3>
        <div class="grid">
          ${[1,2].map(() => html`
            <div class="tile empty">
              <span class="art">＋</span>
              <div class="meta">
                <div class="label">No favourites yet</div>
                <div class="kind">Save one from Browse → Radio</div>
              </div>
            </div>
          `)}
        </div>
      `;
    }
    return html`
      <h3><span>Favourites</span></h3>
      <div class="grid">
        ${this.presets.map(p => html`
          <div class="tile" role="button" tabindex="0"
               @click=${() => this.play(p.id)}
               @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") this.play(p.id); }}>
            <span class="art">
              ${isImageUrl(p.artwork_url)
                ? html`<img src=${p.artwork_url} alt="" />`
                : html`<span>${this.fallbackGlyph(p)}</span>`}
            </span>
            <div class="meta">
              <div class="label">${p.label}</div>
              <div class="kind">${p.kind}${p.slot != null ? ` · slot ${p.slot}` : ""}</div>
            </div>
            <span class="play-hint">${this.busy === p.id ? "…" : "▶"}</span>
            <button class="del" title="Delete preset"
                    @click=${(e: Event) => this.erase(p, e)}>✕</button>
          </div>
        `)}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "st-favourites": StFavourites; } }
