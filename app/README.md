# Nanoscope — MQTT Dashboard

Single-screen operator console for exploring and debugging MQTT traffic, implemented from the
design spec in [`../design/README.md`](../design/README.md). React + TypeScript + Vite, live data
via [mqtt.js](https://github.com/mqttjs/MQTT.js).

## Running

Copy `../.env.example` to `../.env` and set your broker address and API credentials.
Vite loads configuration from the repository root; exported environment variables
take precedence. Restart Vite after changing configuration.

Use the Node version pinned in `.nvmrc` (currently 20.20.2).

```bash
nvm use
npm ci
npm run dev
```

Open http://localhost:5180.

By default the UI runs in **server mode** and expects the Go backend in
[`../server`](../server) to be running — that is what provides 24h of history.
Start it with `go build -o nanoscope . && ./nanoscope` before `npm run dev`.

Append `?mode=live` to the URL (or set `NANOSCOPE_MODE=live`) for the original
browser-direct MQTT path, which needs no backend but shows nothing that
happened before the tab opened.

## Data sources

The UI reads from one of two sources, chosen by `?mode=` or `NANOSCOPE_MODE`
and implemented behind a common interface in [src/source/](src/source/):

- **`server`** (default) — the Go backend. It has been subscribed to the broker
  the whole time, so load starts with the retention window's topic tree,
  throughput history, and the most recent page of messages; older pages are
  fetched on demand. Live updates arrive over a websocket.
- **`live`** — the browser connects to the broker itself, exactly as before.
  No persistence, no history.

Only the source layer differs; the store, components and styling are shared.

## How live mode connects

When the target broker only listens on raw TCP `1883` — browsers can't speak
raw TCP, so the Vite dev server runs a **WebSocket→TCP bridge** at `/mqtt`
(see `mqttBridge()` in [vite.config.ts](vite.config.ts)): the browser's mqtt.js client speaks
MQTT-over-WebSocket to the dev server, which pipes bytes to the broker.

The broker's HTTP API (`:8081`, credentials from the root `.env`) is proxied at `/hapi` to avoid CORS.
The proxy adds Basic authentication server-side from `MQTT_API_USER` and
`MQTT_API_PASS`; credentials are never sent to the browser. A production live-mode
metadata proxy must attach credentials in the same way.
It supplies the CLIENTS tab, the connected-client count, and broker uptime.

Configuration knobs:

- `MQTT_HOST` / `MQTT_PORT` / `MQTT_API_PORT` env vars for the dev server (default `127.0.0.1:1883` / `8081`)
- `MQTT_API_USER` / `MQTT_API_PASS` for server-side metadata authentication (empty by default)
- `?broker=ws://host:port/path` URL param to point the browser at any MQTT-over-WebSocket
  endpoint directly, bypassing the bridge

For production, either keep a bridge (any ws↔tcp relay works) or enable a WebSocket listener on
the broker (NanoMQ: `listeners.ws` on `:8083/mqtt`) and pass `?broker=`.

## Architecture

- [src/store.ts](src/store.ts) — single external store (`useSyncExternalStore`). Bounded message
  buffer (880 in live mode, up to 5,000 history messages in server mode; initially renders 120), per-topic throughput buckets (20×15s), spark buckets (40×1s).
  UI actions emit immediately; the message firehose is coalesced to ~10 Hz so a busy broker
  never re-renders per message.
- [src/source/index.ts](src/source/index.ts) — shared source interface and mode selection.
- [src/source/live.ts](src/source/live.ts) — mqtt.js wiring: subscribes `#` + `$SYS/#`,
  feeds the store, and publishes with ack/error reporting.
- [src/source/server.ts](src/source/server.ts) — backend bootstrap, history queries,
  latest-per-topic queries, WebSocket updates, and publishing.
- [src/budget.ts](src/budget.ts) — fair-share message eviction across topics.
- [src/httpApi.ts](src/httpApi.ts) — best-effort NanoMQ HTTP API poller (5s); missing
  endpoints/fields degrade to `—`.
- [src/alerts.ts](src/alerts.ts) — client-side alert rules (v1), edit to suit real topics.
- [src/components/](src/components/) — Header, StatStrip, LeftRail (tree/saved filters/alerts),
  CenterPane (STREAM / TOPICS / CLIENTS / PUBLISH), Inspector (JSON token highlighting).

Topic search accepts plain substrings or MQTT wildcards (`+`, `#`). Scope, QoS chips,
RETAINED, and `$SYS` visibility compose. Selection persists as messages arrive; the inspector
never auto-jumps.

## Notes vs. the design

- Stat strip values that the broker doesn't expose (`INFLIGHT / QUEUED`, per-message client id)
  render as `—`. NanoMQ 0.21 doesn't publish `$SYS` counters by default; TOTAL RECEIVED falls
  back to the session count.
- CLIENT ADDRESS and TX/RX columns show `—` — NanoMQ's `/api/v4/clients` doesn't return them.
- A broker-disconnected banner (magenta accent, per the spec's suggestion) appears at the bottom
  when the connection drops; mqtt.js auto-reconnects every 3s.
