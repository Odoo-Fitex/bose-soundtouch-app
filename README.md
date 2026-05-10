![Project Logo](soundtide-icong.svg)
# SoundTide

A local-first replacement for the Bose SoundTouch app, designed for a household
of SoundTouch 10 / 20 / 30 speakers after the May 2026 cloud shutdown.

This monorepo contains three components:

| Folder    | Runs on                                    | What it does |
|-----------|--------------------------------------------|--------------|
| `agent/`  | Raspberry Pi (Docker)                      | Speaker discovery, control, UPnP MediaServer for radio streams, presets, zones, scheduler, and an outbound tunnel to the Worker. |
| `worker/` | Cloudflare Workers (free tier)             | Off-LAN entry point: relays PWA requests through the tunnel, mirrors presets/scenes to D1 for backup, hosts the PWA on Cloudflare Pages. |
| `pwa/`    | Any modern browser (mobile or desktop)     | The actual app. Vite + Lit + TypeScript. Installable on iPhone/iPad/macOS/Windows/Android. |

See `../SoundTide_DesignDoc.docx` for the full design rationale.

## Settings checklist (read before first launch)

You can run the agent with zero changes to `.env`, but two things benefit from
attention before `docker compose up`:

**Required to think about:**
- **`TZ`** in `.env` — set to your IANA time zone (e.g. `Europe/Paris`,
  `America/New_York`). Cron expressions are evaluated in the container's local
  time, so without this your 07:00 alarm fires at 07:00 UTC.
- **Hostname when flashing the Pi** — set it to `soundtide-agent` in the Pi
  Imager's advanced options, so the PWA can reach the agent at
  `http://soundtide-agent.local:7780` from any phone on the LAN.

**Worth setting up next, but optional:**
- **Static DHCP lease** for the Pi in the router (so a router reboot doesn't
  change the IP and break the PWA's bookmarks).
- **`SOUNDTIDE_NAS_WOL_MAC`** — only if you want the in-app *Wake NAS* button.
  Enable WOL in DSM first (Control Panel → Hardware & Power), then paste the
  NAS LAN-port MAC here.
- **`SOUNDTIDE_WORKER_URL` + `SOUNDTIDE_HOUSEHOLD_TOKEN`** — only if you want
  off-LAN access. See the next section.

**Things you don't need to set:**
- Speaker IPs, MACs, or any per-device config — discovery is automatic via
  SSDP and mDNS.
- Radio station list — fetched live from radio-browser.info.
- DLNA / Synology server URL — the agent picks it up automatically when the
  NAS is awake on the LAN; if it doesn't appear, paste the description URL in
  Settings → NAS once.

**Network requirements** (true regardless of config):
- The Pi must be on the **same VLAN as the speakers**, with multicast and
  IGMP snooping enabled (default on most home routers, sometimes disabled on
  mesh systems — check the router admin if no speakers appear after 60 s).
- Outbound TCP/443 must work for `radio-browser.info` and the optional
  Worker tunnel; nothing inbound to the home router is required.

## Quick start (LAN-only)

```bash
# 1. On the Raspberry Pi (Pi OS Lite 64-bit, Docker installed):
git clone <this repo> ~/soundtide && cd ~/soundtide
cp .env.example .env
$EDITOR .env             # at minimum, set TZ
docker compose up -d

# 2. From a phone or laptop on the same Wi-Fi:
#    open http://soundtide-agent.local:7780  (or http://<pi-ip>:7780 )
#    install to home screen for the standalone PWA experience
```

The agent will discover all SoundTouch speakers on the LAN within ~30 seconds.

## Auto-update from GitHub (optional)

The `scripts/auto-update.sh` script polls GitHub for new commits and rebuilds
the container when there are any. Wire it up with cron once and the Pi will
keep itself current.

```bash
# On the Pi, after the first successful 'docker-compose up -d':
chmod +x ~/soundtide/scripts/auto-update.sh

# Every 15 minutes, check for updates. Logs go to ~/soundtide/auto-update.log
( crontab -l 2>/dev/null; \
  echo "*/15 * * * * /home/$USER/soundtide/scripts/auto-update.sh >> /home/$USER/soundtide/auto-update.log 2>&1" \
) | crontab -

# Verify it's installed:
crontab -l
```

`auto-update.sh` is a no-op when there are no new commits, so polling every
few minutes is cheap. The first run after a real push takes 30–90 s to
rebuild and restart the agent.

If you'd rather use systemd than cron:

```bash
sudo tee /etc/systemd/system/soundtide-update.service >/dev/null <<'EOF'
[Unit]
Description=SoundTide auto-update
After=network-online.target docker.service
[Service]
Type=oneshot
User=$USER
WorkingDirectory=/home/$USER/soundtide
ExecStart=/home/$USER/soundtide/scripts/auto-update.sh
EOF
sudo tee /etc/systemd/system/soundtide-update.timer >/dev/null <<'EOF'
[Unit]
Description=Run soundtide-update every 15 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now soundtide-update.timer
systemctl list-timers | grep soundtide   # confirm it's scheduled
```

The systemd version is slightly cleaner because you can `journalctl -u
soundtide-update` to see history, and timers survive reboots cleanly.

## Off-LAN access (optional)

```bash
# Once, on a workstation:
cd worker
npm install
npx wrangler login
npx wrangler d1 create soundtide
# put the resulting database_id into wrangler.toml
npx wrangler d1 execute soundtide --file=./schema.sql
npx wrangler deploy

# Tell the Pi about it:
# in soundtide/.env on the Pi, set:
#   SOUNDTIDE_WORKER_URL=wss://soundtide.<your-subdomain>.workers.dev/tunnel
#   SOUNDTIDE_HOUSEHOLD_TOKEN=<long-random-string-you-pick>
docker compose restart agent
```

The PWA, when loaded from the worker URL, will automatically use the tunnel.

## Repository layout

```
soundtide/
├── docker-compose.yml         Pi runtime
├── .env.example
├── agent/                     Node 22 / TypeScript service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.ts           Entry: boots HTTP, WS, discovery, scheduler, tunnel, UPnP MS
│       ├── config.ts
│       ├── log.ts
│       ├── db/                better-sqlite3 storage (presets, scenes, schedules)
│       ├── soundtouch/        XML/HTTP client + 'gabbo' WS subscriber
│       ├── discovery/         SSDP + mDNS
│       ├── upnp/              Embedded mini UPnP MediaServer (replaces Gerbera)
│       ├── radio/             radio-browser.info wrapper
│       ├── nas/               UPnP/DLNA browser for the Synology library
│       ├── api/               PWA-facing REST + WebSocket
│       ├── scheduler/         node-cron alarms / wake-up radio
│       └── tunnel/            Worker WebSocket client
├── worker/                    Cloudflare Worker
│   ├── wrangler.toml
│   ├── schema.sql
│   ├── package.json
│   └── src/
│       ├── index.ts           Hono app
│       ├── tunnel.ts          Durable Object for the household tunnel
│       └── db.ts              D1 helpers
└── pwa/                       Vite + Lit + TypeScript
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    ├── public/
    │   ├── manifest.webmanifest
    │   └── icons/
    └── src/
        ├── main.ts
        ├── api.ts             LAN/Worker auto-detect + WebSocket fan-in
        ├── store.ts           tiny signals store
        ├── components/        Lit elements per screen
        ├── styles.css
        └── sw.ts              service worker (offline shell)
```

## Notes / deviations from the design doc

- The design doc proposes Gerbera as the UPnP MediaServer. To eliminate a second
  Docker container and keep the agent self-contained, this implementation embeds
  a minimal UPnP MediaServer in Node (`agent/src/upnp/`). Functionality is the
  same as far as the SoundTouch is concerned. Gerbera remains a viable swap-in
  if you ever want richer indexing.
- Authentication on the LAN is "trust the LAN" — anyone who can reach the agent
  on port 7780 can drive the speakers, which matches the SoundTouch firmware's
  own threat model. Off-LAN access is gated by a household bearer token.
  Passkey/WebAuthn enrollment is sketched in `worker/src/auth.ts` for a later
  milestone.
- License: MIT. "Bose" and "SoundTouch" are trademarks of Bose Corporation; this
  project is not affiliated with or endorsed by Bose.
