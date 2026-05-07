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

## Quick start (LAN-only)

```bash
# 1. On the Raspberry Pi (Pi OS Lite 64-bit, Docker installed):
git clone <this repo> ~/soundtide && cd ~/soundtide
cp .env.example .env
docker compose up -d

# 2. From a phone or laptop on the same Wi-Fi:
#    open http://soundtide-agent.local:7780  (or http://<pi-ip>:7780 )
#    install to home screen for the standalone PWA experience
```

The agent will discover all SoundTouch speakers on the LAN within ~30 seconds.

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
