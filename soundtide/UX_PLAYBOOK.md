# SoundTide UX playbook

Lessons distilled from the apps that ship millions of multi-room speakers and
the (very loud) communities behind them. Used as a backlog and design
north-star for SoundTide.

## What the leaders do well

| App | What's loved | What's hated |
|---|---|---|
| **Sonos S2 (pre-2024)** | One unified "Rooms" screen, master+per-speaker volume, queue editing, favourites pinned, sleep timer & alarms, NAS browse | n/a |
| **Sonos new (post-2024)** | Faster home screen, customizable | Lost sleep timer (later restored), lost queue edit, lost NAS search, slow to find system, breaks on updates |
| **B&O Beoplay** | Beautiful Now Playing, EQ presets ("relaxed / bright / warm / excited"), room-placement EQ ("corner / wall / free"), Beolink "link" icon for instant grouping | Per-speaker volume in groups is awkward, multi-app dance with Google Home |
| **BluOS (Bluesound)** | Rock-solid stability, very wide native service support (20+), Roon-friendly | Aesthetic less polished |
| **HEOS (Denon)** | Tight integration with Denon AVRs, multi-source per zone | Frequent freezes that need a power cycle |
| **Apple Home / AirPlay 2** | Control Center "what's playing where" view, automatic stereo-pair prompt when two speakers in same room, Siri voice routing | Limited browsing, Apple ecosystem only |

## Universal best-practice patterns (steal these)

1. **One Now Playing per room, not one Now Playing total.** Tap a room → see what *that* room is playing, with a horizontal strip of every speaker's current state visible.
2. **Master volume + per-member volume when grouped.** Big slider for the group, small sliders for each member, all visible at once. This is the #1 thing apps screw up.
3. **Linking gesture as a single tap, not a multi-screen flow.** Sonos: tap room icon. B&O: tap link icon. Apple: long-press AirPlay button. SoundTide should match: a small "+ add room" chip on Now Playing.
4. **Pinned favourites on the home screen.** Users come back to the same 4–8 things 90 % of the time. Always-visible, one-tap.
5. **Search bar that spans every source** (radio, NAS, podcasts) and the speakers themselves.
6. **Sleep timer + alarms as first-class features.** Sonos got destroyed for hiding these.
7. **Room placement EQ.** B&O's "near a wall / in a corner / free" presets are cheap to implement (just bass/treble offsets) and feel premium.
8. **Stereo-pair detection.** When two ST10s sit on the same network, prompt to pair them as a stereo group. (For us: just a "Stereo bedroom" zone with a banner explaining it's mono-mono sync.)
9. **Always-visible mini-player.** Keep transport + volume reachable from anywhere in the app — Browse, Settings, anywhere.
10. **Optimistic UI + WebSocket reconciliation.** Click registers instantly even before the speaker confirms; the gabbo WS catches up. We already do this; double down.
11. **First-run onboarding.** Sonos's biggest complaint is "minutes to find my speakers." We can do an animated "Looking for speakers…" with a skipable list so the user is never staring at a blank screen.
12. **Continuity across devices.** Phone, tablet, laptop should all show the same favourites, the same scenes, the same alarms.

## What users keep asking for (and getting denied)

- Proper **parametric EQ** (Sonos still doesn't have one). For us, the two-band /audioproducttonecontrols (bass + treble) is the most we get from the speaker — but that's still better than Sonos.
- **NAS / local library search.** Sonos removed it; users are furious. We have it; surface it well.
- **Sleep timer.** Removed by Sonos, returned by community pressure.
- **Queue edit (move / clear / save as playlist).** SoundTouch's API doesn't expose a queue, so we can't do this for radio/NAS, but we *can* do it for "what's queued in our preset list".
- **Per-room source independence.** Play different things in different rooms simultaneously — already supported by us, just need a UI that makes it discoverable.
- **A persistent home screen** users can customise (re-order rooms, re-order presets).

---

## Concrete backlog for SoundTide (prioritised)

### Tier 1 — high impact, ~1 evening each

These directly close the gap with B&O / Sonos-pre-2024 and address the loudest community gripes.

| # | Feature | Where |
|---|---|---|
| **1** | **Mini-player** docked above the bottom nav, visible on every tab. Shows speaker name, track title, ▶/⏸ button, quick volume tap. | new `<st-mini-player>` between `<main>` and `<nav>` in `st-app.ts` |
| **2** | **Room strip** at the top of every screen (not just Now Playing) showing every speaker as a pill with mini "Now Playing" text. Tap to switch. | promote the speakers row from `st-now-playing.ts` into a shared component |
| **3** | **Master + per-member volume** when the selected speaker is in a zone. Big slider for the group, small sliders that ratio-scale. | extend `st-now-playing.ts` with a `<st-zone-volumes>` panel |
| **4** | **Pinned favourites grid** on launch (first 6 presets). Promote to the Now Playing screen above the artwork when nothing is playing. | new "empty state" branch in `st-now-playing.ts` |
| **5** | **Sleep timer** (15 / 30 / 60 / 90 min). Implemented client-side: count down, then send `PAUSE` and `POWER`. | new `<st-sleep-timer>` modal accessible from mini-player |
| **6** | **Search bar on Now Playing** that hits radio + NAS + presets in one query. | reuse `api.radioSearch` + new `/search` endpoint that fans out |
| **7** | **First-run onboarding** with animated "Looking for speakers…" and a skippable manual-IP entry. | new `<st-onboarding>` component, shown when `$devices.get().length === 0` |
| **8** | **Theme** auto / dark / light, `prefers-color-scheme` respected. | CSS custom properties in `styles.css`, toggle in Settings |

### Tier 2 — premium feel, ~weekend each

| # | Feature | Where |
|---|---|---|
| **9** | **Bass / Treble per speaker** using `/audioproducttonecontrols`. Two sliders + an "EQ presets" row (Relaxed / Warm / Bright / Voice). | new `<st-eq>` component on Now Playing |
| **10** | **Room placement presets** ("Free / Wall / Corner") that apply bass/treble offsets. | preset values in `st-eq.ts`, no API needed beyond /bass + /audioproducttonecontrols |
| **11** | **Stereo-pair wizard** for two ST10s. Detect the pair, offer to create a "Stereo Bedroom" zone with a tooltip explaining mono-mono sync. | new `<st-stereo-pair-prompt>` triggered from Settings |
| **12** | **Quick-link buttons** for AirPlay / Spotify Connect / Bluetooth on Now Playing. AirPlay: open `airplay:` deep link. Spotify: `spotify:` URI. BT: send `/select` with `BLUETOOTH`. | tab below transport |
| **13** | **Drag-to-group** on Zones tab. Drag a speaker pill onto another to form a zone. | use HTML5 drag API; sortable.js as fallback |
| **14** | **Recently played** list per speaker (last 20 ContentItems we sent). | new D1/SQLite table + `<st-recents>` row |
| **15** | **Per-room playback summary** in Settings: "Living room played 4h12m today, mostly Radio." | aggregate from a new `play_log` table |
| **16** | **Now Playing artwork as background blur** when the speaker has art. | CSS backdrop-filter, no JS |

### Tier 3 — power-user / future

| # | Feature | Where |
|---|---|---|
| **17** | **Multi-source per zone** (different songs in different rooms simultaneously) — already works under the hood; UI needs to expose it. | rework `st-zones.ts` |
| **18** | **Voice search** via Web Speech API (mic button next to search). | progressive enhancement |
| **19** | **HomeKit bridge** so Apple Home can see SoundTide-controlled SoundTouches. | a new `homekit/` Node module with `hap-nodejs` |
| **20** | **Customisable home screen** — drag-reorder rooms and favourites, optionally hide. | persisted in localStorage, optimistic |
| **21** | **PWA share target** so you can `Share → SoundTide` a stream URL or Spotify link from another app to make it a preset. | manifest `share_target` + a new POST endpoint |
| **22** | **Lock-screen / Media Session API** so ▶/⏸/skip buttons appear on iOS lock screen. | `navigator.mediaSession` API in PWA |

---

## Layout responsiveness checklist

The current PWA is mobile-first; widening it to tablets and desktops is mostly
container-query plumbing.

- [ ] Single column ≤ 600 px (current).
- [ ] Two columns 600–1024 px: room list on the left, Now Playing on the
      right, mini-player spans the bottom.
- [ ] Three columns ≥ 1024 px: rooms / Now Playing / queue + recents.
- [ ] Touch targets stay ≥ 44 × 44 pt on every breakpoint.
- [ ] Skeleton loaders while `$devices` is empty (instead of "Looking for
      speakers…").
- [ ] Pull-to-refresh on mobile, ⌘R-friendly cache headers everywhere else.
- [ ] Reduced-motion respected (`prefers-reduced-motion`).
- [ ] Safe-area insets on iOS for notch / home-bar.
- [ ] Haptic feedback (`navigator.vibrate`) on Power, Mute, preset taps.
- [ ] Keyboard shortcuts on desktop: space=play/pause, arrows=skip, +/-=volume.

---

## Sources

The patterns above are distilled from these reads:

- [Sonos app redesign UX/UI case study (Medium)](https://medium.com/@m.dujardin/sonos-app-redesign-ux-ui-case-study-e174f748c804)
- [What Hi-Fi? — Sonos multi-room review](https://www.whathifi.com/reviews/sonos-multi-room-system)
- [Sonos community: features users miss](https://en.community.sonos.com/controllers-and-music-services-229131/new-sonos-app-many-features-no-longer-available-6892113)
- [Tom's Guide — Sonos walks back changes, restores sleep timer](https://www.tomsguide.com/audio/sonos-walks-back-some-of-its-controversial-app-changes-adds-back-a-sleep-timer)
- [B&O support — features in the Bang & Olufsen app](https://support.bang-olufsen.com/hc/en-us/articles/360041401012-Which-features-are-included-in-the-Bang-Olufsen-app)
- [TechRadar — Beoplay M3 review](https://www.techradar.com/reviews/bo-beoplay-m3)
- [BluOS vs HEOS app UI thread (AVForums)](https://www.avforums.com/threads/bluos-vs-heos-for-app-ui.2248745/)
- [Apple Newsroom — iOS 11.4 multi-room AirPlay 2 launch](https://www.apple.com/newsroom/2018/05/ios-11-4-brings-stereo-pairs-and-multi-room-audio-with-airplay-2/)
- [Music Assistant — multiroom synchronized audio discussion](https://github.com/orgs/music-assistant/discussions/385)
- [TechRadar — vibe-coded Sonos alternatives roundup](https://www.techradar.com/audio/people-have-been-making-alternatives-to-the-sonos-app-using-ai)
