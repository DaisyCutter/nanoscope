# Nanoscope backend

Go service that stays subscribed to the NanoMQ broker and keeps a rolling
**24 hour** window of every message on disk, so the dashboard shows history
from before the browser was opened.

```bash
go build -o nanoscope .
./nanoscope
```

Then run the UI with `npm run dev` in [`../app`](../app) — the vite dev server
proxies `/api` here.

## Why it exists

In live mode the browser connects to the broker itself and holds a ring buffer
of the last few hundred messages. Close the tab and everything is gone. This
service is always connected, so the ring buffer becomes a window over real
history.

It also replaces two dev-only hacks: the WebSocket→TCP bridge and the `/hapi`
CORS proxy in `../app/vite.config.ts`. Those only ever existed inside the vite
dev server, so live mode has never really worked in a production build. This
does.

## Configuration

Copy `../.env.example` to `../.env` and fill in your local values.
The backend loads `.env` from its working directory, or `../.env` if absent.
The first existing file is used; invalid files stop startup without printing values.
Exported environment variables override the file, and flags override both.
There are no built-in API credentials. Keep `.env` outside the static assets directory.

## Flags

| Flag | Env | Default | |
|---|---|---|---|
| `-broker-host` | `MQTT_HOST` | `127.0.0.1` | broker address |
| `-broker-port` | `MQTT_PORT` | `1883` | broker TCP port |
| `-api-port` | `MQTT_API_PORT` | `8081` | NanoMQ HTTP API |
| `-api-user` / `-api-pass` | `MQTT_API_USER` / `MQTT_API_PASS` | *(empty)* | HTTP API basic auth |
| `-listen` | `LISTEN` | `:8090` | HTTP listen address |
| `-db` | `DB_PATH` | `nanoscope.db` | SQLite file |
| `-retention` | — | `24h` | how long raw messages are kept |
| `-max-payload` | `MAX_PAYLOAD` | `65536` | per-message payload cap |
| `-static` | `STATIC_DIR` | *(off)* | serve a built frontend from here |

With `-static ../app/dist` the binary serves the UI too, so a deployment is one
binary plus one directory.

## How storage works

Two tables, in [store.go](store.go):

- **`messages`** — one row per message, indexed on `ts` and on `(topic, ts)`.
  Pruned every minute to the retention horizon.
- **`buckets`** — one row per wall-clock minute holding a count and byte total.
  1440 rows cover 24h. Pruned separately, so the long throughput series
  survives even as raw messages age out.

Writes are batched into a transaction every 200ms rather than one insert per
message, which is what keeps a `#` subscription cheap. SQLite runs in WAL mode
so the API can read while ingest writes.

Per-topic totals live in an in-memory index, incremented on ingest and rebuilt
from SQL after each prune — so the topic tree reflects the retention window
rather than the session.

**Sizing.** At a steady 10 msg/sec with 200-byte payloads, 24h is roughly
860k rows and a few hundred MB. Watch the first day's growth and adjust
`-retention` or `-max-payload` before assuming the defaults fit. The file
reaches a steady size once pruning catches up; no `VACUUM` is needed.

## API

| | |
|---|---|
| `GET /api/bootstrap` | everything the UI needs on load — see below |
| `GET /api/messages` | `?scope=&limit=&before=&since=&qos=&retained=` |
| `GET /api/latest` | latest matching message per topic (`scope`, `limit`, `qos`, `retained`, `since`) |
| `GET /api/health` | service health response |
| `GET /api/topics` | per-topic aggregates over the window |
| `GET /api/clients` | client list, polled from the broker's HTTP API |
| `GET /api/stats` | counters |
| `POST /api/publish` | `{topic, payload, qos, retain}` |
| `GET /api/live` | websocket: batched `msgs` frames + 1Hz `stats` frames |

### The bootstrap shape matters

`/api/bootstrap` returns 24h of **aggregates** — the topic index and the minute
buckets — plus **one window** of recent messages, not 24h of raw messages. A
day of traffic is hundreds of thousands of rows; the browser cannot hold that
and does not need to. The UI pages backwards through the rest on demand
(`?before=`), and re-queries when you scope to a topic.

That split is the main thing to preserve if you change this: aggregates are
cheap and bounded, raw messages are neither.

## Wire types

`types.go` mirrors `../app/src/types.ts`. The json tags are the contract —
change one side and you must change the other. It's about 30 fields; there is
no codegen, deliberately.
