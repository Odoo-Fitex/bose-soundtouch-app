# Taking SoundTide public

Strategic notes on moving SoundTide from a one-household project to a tool
other Bose SoundTouch owners can install and use after the May 2026 cloud cut.
This is opinionated — adjust as you go.

## 1. The hard constraint

Every household needs an **always-on LAN box** running the agent. The
SoundTouch firmware:

- Only exposes its API on the LAN (no inbound from the internet).
- Discovers UPnP MediaServers via SSDP multicast — requires a server on the
  same broadcast domain.
- Requires the controller to maintain WebSocket connections per speaker.

That puts SoundTide in the "self-hosted home appliance" category alongside
Home Assistant, Pi-hole, Plex Media Server, AdGuard Home, BubbleUPnP Server.
**You cannot run a SaaS that controls users' speakers from your own cloud.**

That single fact shapes everything below.

## 2. Distribution: three tiers of polish

Each tier roughly doubles the addressable audience.

### Tier 1 — Open-source, "developers + tinkerers" (week 1)

- Public GitHub repository under MIT license.
- The current `docker-compose.yml` is the canonical install.
- README with the existing setup checklist.
- A few seeded radio favourites in `data/seed.sql`.
- Issues / Discussions enabled.

Audience: Home Assistant users, r/homelab, Hacker News crowd. Maybe 100–500
installs in the first months. Useful as a beachhead and bug-finder.

### Tier 2 — Easy-install, "Synology / NUC owners" (month 2)

Push the friction down without changing the architecture:

- **Docker Hub image** — `soundtide/agent:latest` built via GitHub Actions.
  `docker compose pull && up` becomes a one-liner.
- **Home Assistant add-on** — a thin wrapper letting HA owners add SoundTide
  from the add-on store. HA has ~600k active installs, many of them
  audio-savvy.
- **Synology Package (SPK)** — Synology owners are a meaningful chunk of
  the SoundTouch demographic (NAS music libraries, AirPlay 2 fans). A
  pre-built package in their Package Center adds one more click.
- **Raspberry Pi Imager preset** — submit a `pi-imager` preset so users see
  "SoundTide Hub" alongside Pi-hole when flashing.
- **A landing page** — `soundtide.app` (or similar). One screenshot, a
  90-second video, three install paths, a link to the repo, an FAQ. No
  sign-up.

Audience: anyone with a NAS, a spare Pi, or Home Assistant. Targeting **5k–
20k installs over the first year** is realistic.

### Tier 3 — Pre-built appliance, "anyone" (month 6+)

For non-technical SoundTouch owners who just want the music back on:

- **A Crowdsupply / Indiegogo run** for a pre-flashed Pi Zero 2 W in a small
  case, sold at cost + a small margin (~£40). The user plugs it into Wi-Fi
  via a captive-portal setup wizard.
- Or skip the hardware and **partner with FriendlyARM / Argon** to ship a
  pre-imaged microSD card.
- Optionally a **mDNS-enabled iOS/Android wrapper** of the PWA on the App
  Store, so the user doesn't need to know what `.local` means.

This tier is what reaches the long tail of SoundTouch owners — people who
bought a SoundTouch 30 in 2017 and just want their kitchen radio back. It is
also a real product, with returns, support, packaging, and shipping. Don't
do this until Tier 2 has been running for 6 months and you've absorbed the
bug surface.

## 3. Legal and intellectual property

Read the **Bose SoundTouch Web API Terms of Use** verbatim before publishing
anything (you already have the PDF). The relevant clauses summarised:

- License is **world-wide, royalty-free, revocable, non-sublicensable**.
- You can distribute Applications under your own EULA, provided it meets
  Addendum A.
- You can use the words "Bose" and "SoundTouch" only as **adjectives**, never
  as the name of your product. "SoundTide" is fine; "Bose SoundTide" or
  "SoundTide for SoundTouch" with Bose's logo would be a red flag.
- No fault-tolerant / mission-critical use, no implied endorsement.
- Disparagement, IP claims against Bose, or perceived infringement let Bose
  terminate immediately.

**Practical checklist before going public:**

1. Add a top-of-README disclaimer:
   *"Bose and SoundTouch are trademarks of Bose Corporation. SoundTide is
   not affiliated with, endorsed, or sponsored by Bose. All trademarks are
   property of their respective owners."*
2. Ship an `EULA.md` based on Addendum A. (~150 lines — straightforward.)
3. License the code as **MIT**. Not GPL — keeps integrators happy.
4. Don't ship Bose firmware, screenshots of the official app, or any
   copyrighted image. Use original artwork.
5. Don't claim API documentation accuracy ("as published by Bose"); link to
   their PDF instead.
6. **Cease-and-desist insurance**: zero. Worst case a Bose lawyer asks you
   to rename or remove specific text — the project survives. Worst worst
   case: they revoke your API license. The whole community would be in the
   same boat, so the social cost of doing that is high.

## 4. Privacy & data — keep it boring

Don't store user data centrally. This sidesteps GDPR-heavy obligations:

- **No cloud account.** No login, no user database, no cookies, no
  analytics. The app is anonymous to the publisher.
- **All user state stays on the LAN agent's SQLite.** Backups go to the
  user's own R2/B2/Drive if they configure them.
- **Off-LAN tunnel is BYO Cloudflare** — each user deploys their own Worker
  to their own Cloudflare account. You publish the worker source as part of
  the repo; users `wrangler deploy` it themselves.
- **Telemetry**: opt-in only. A single anonymous "install registered"
  ping to your domain on first boot, nothing more — and even that should be
  off by default. You don't actually need it.

The product *cannot* leak user data because it never has it. That's a
sellable property.

## 5. Off-LAN access at scale

Right now the design uses a single Cloudflare Worker on the developer's
account. That doesn't scale to 10k households (Workers free tier: 100k
req/day across the whole account, not per-household).

Options, ordered by effort:

1. **BYO Cloudflare** (recommended start). The repo includes a
   `wrangler.toml` template; users run `wrangler login` and `wrangler deploy`
   on their own free tier. Each household consumes its own quota. You pay
   nothing.
2. **A managed "SoundTide Cloud" tier** for non-technical users at, say,
   €1.99/mo or €15/yr. Hosted on your Cloudflare paid plan, multi-tenant
   Durable Objects. Margins are healthy because actual traffic per household
   is tiny.
3. **Skip off-LAN entirely** — emphasise that for most users, controlling
   the speakers when they're not home isn't important. Ship a **"works on
   home Wi-Fi"** product that's simpler and cheaper.

I'd start with option 1 and add option 2 only when there's clear demand and
~1000 users.

## 6. Community & support burden

Self-hosted projects live or die on community. Three things move the needle:

- **A Discord or Matrix server.** Centralises support away from GitHub
  Issues. Pin a #install-help channel.
- **Good error messages in the agent.** Every common failure mode (multicast
  blocked, NAS asleep, firmware refusing payload) should produce a clear log
  line and ideally a banner in the PWA. Most "support tickets" become
  self-service this way.
- **Keep PR review responsive.** Active projects get better contributors;
  abandoned ones bleed contributors fast.

Set the expectation that you maintain the project as a side gig, not as a
service. Respond to clear bug reports within a week, mark intentionally-
out-of-scope features early, close stale issues.

## 7. Possible commercial paths

Most self-hosted projects don't make money, and that's fine. If you do want
revenue:

| Path | Effort | Likely revenue ceiling |
|---|---|---|
| Donations (GitHub Sponsors, ko-fi) | Tiny | $50-500/mo |
| Optional hosted off-LAN tier | Medium | $5k-20k/yr at 5k users |
| Pre-built hardware appliance | High | $50k-200k/yr at 1k units/yr |
| Paid enterprise / business sound (hotels, restaurants) | High | $$$ but a different product |
| Consulting (custom integrations) | Medium | varies |

The *typical* successful self-hosted project is a one-person open-source
codebase with a small Patreon. Don't quit your day job for SoundTide; build
it because SoundTouch owners deserve a working app, and let revenue follow
if and when it does.

## 8. The first-90-days roadmap

If I were you and wanted to push this public, here's what I'd do in order:

**Days 1-7 — Get the repo public**
- Final pass on the README so a stranger can install it.
- Add `LICENSE` (MIT), `CONTRIBUTING.md`, `EULA.md`.
- Add the trademark disclaimer in the README + about screen.
- Make the GitHub repo public; tag `v0.1.0`.
- Open discussion on the existing `r/bose` SoundTouch alternatives mega-
  thread linking to the project. Get the first 10 testers.

**Days 7-30 — Reduce install friction**
- Set up GitHub Actions to push images to Docker Hub.
- Write a Home Assistant add-on wrapper.
- Spin up a static landing page (Cloudflare Pages, no-cost).
- Write a 2-minute installation video.
- Set up Discord; announce on r/homeassistant, r/homelab, r/bose,
  Hacker News (Show HN), Lobsters.

**Days 30-60 — Smooth out the rough edges**
- Track the top three install failures in Discord; fix the agent's error
  messages so each one becomes self-diagnosing.
- Add the bass/treble EQ from Tier 2 of the UX playbook.
- Add a "Wake from sleep on first cast" so the speaker auto-powers when a
  source is sent (today the user has to press POWER first).
- If demand for off-LAN is real, ship the Cloudflare Worker template and a
  one-paragraph deploy guide.

**Days 60-90 — Decide where to invest**
- Look at the data: how many installs, what's the support burden, are people
  asking for a hosted tier, are they asking for a hardware appliance?
- Pick **one** of: managed off-LAN, hardware appliance, App-Store wrapper,
  or NAS support. Don't try to do all four.
- If revenue matters: open GitHub Sponsors and put a "buy me a coffee" tile
  on the landing page. That's enough to find out whether anyone cares.

## 9. Things to deliberately *not* do

- **Don't try to scale to non-SoundTouch products.** "SoundTide for
  Multi-Room" is a project five times harder than this one.
- **Don't centralise auth.** No "log in with SoundTide". Users hate it,
  GDPR makes it expensive, and the local-only architecture doesn't need it.
- **Don't build mobile-store native apps prematurely.** The PWA is enough;
  store reviews are a quagmire and Apple's review process is slow.
- **Don't promise SLA.** This is a side-project saving people's speakers
  from landfill, not a paid product. Set expectations early.
- **Don't accept money before you have a license to.** Hosting, hardware
  sales — both raise tax / VAT obligations. Donations are simpler.

---

In summary: open-source it, package it, point at it from the right Reddit
threads, and let it grow. You aren't building a startup; you're saving a
generation of speakers from being landfill, which is a quietly valuable
thing to do.
