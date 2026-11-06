# Working on Nanoscope

## Orientation

This is a small MQTT operator console, with two independent projects and no
root build command. Read `README.md` for startup commands, then the README in
the project you are changing. `design/` is a visual reference, not runtime code.

## Code map

| Area | Start here | Responsibility |
| --- | --- | --- |
| UI entry | `app/src/main.tsx`, `app/src/App.tsx` | Mount UI and connect source |
| Shared state | `app/src/store.ts` | External store via `useSyncExternalStore`, filtering, selection, paging, UI actions |
| Data sources | `app/src/source/index.ts`, `server.ts`, `live.ts` | Common connect/publish/loadOlder interface; backend HTTP/WS or direct mqtt.js |
| UI configuration | `app/src/config.ts`, `app/vite.config.ts` | Buffer limits, source mode, broker URL, dev proxies/bridge |
| Message budget | `app/src/budget.ts` | Per-topic fair-share eviction so busy topics do not crowd out quiet ones |
| UI | `app/src/components/`, `app/src/styles.css` | Rails, tabs, inspector, publish form, styling |
| Direct-mode metadata | `app/src/httpApi.ts`, `app/src/alerts.ts` | Best-effort NanoMQ metrics and client-side alert rules |
| Backend lifecycle | `server/main.go`, `server/config.go` | Configuration, service wiring, periodic flush/fanout/prune, shutdown |
| MQTT ingestion | `server/ingest.go` | Broker connection, subscriptions, publish, counters |
| Persistence | `server/store.go` | SQLite schema, batched writes, history, aggregates, retention, latest-per-topic queries |
| API / streaming | `server/api.go`, `server/hub.go` | REST routes, bootstrap, WebSocket fanout |
| Broker metadata | `server/nanomq.go` | NanoMQ HTTP polling and metrics parsing |
| Wire contract | `server/types.go`, `app/src/types.ts` | Manually mirrored JSON types |

## Data flow and invariants

- Default **server mode**: broker → Go ingest → SQLite and WebSocket hub →
  browser source → shared store → React. Bootstrap returns aggregates and a
  bounded recent message page. Fetch older history on demand; never load the
  entire retention window of raw messages into browser memory.
- **Live mode** (`?mode=live`): mqtt.js → shared store. Vite bridges `/mqtt`
  to broker TCP and proxies `/hapi` for broker metadata. These are dev-server
  features; a static deployment needs its own WebSocket endpoint and metadata routing.
- Keep both data sources working when changing shared state or publishing.
  `?broker=` only changes the direct browser MQTT connection, not the Go backend.
- Preserve bounded buffers and batched updates. Current limits live in
  `config.ts`: 880 live messages, 5,000 history messages, 5,000 latest snapshot
  rows, and 120 initially rendered rows. Preserve fair-share eviction and the
  pagination cursor based on fetched messages rather than retained messages.
- REPLACE mode selects the latest **matching** message per topic. Apply filters
  before choosing the latest row, including backend queries; do not filter only
  an unfiltered latest snapshot. See `server/store_test.go`.
- Scope includes the exact topic and descendants. Preserve selection as new
  messages arrive. Pause/clear affect browser state, not backend recording or
  database retention.
- Update both wire-type files and their consumers when changing JSON fields.
  There is no code generation. Route registration in `server/api.go` is the
  authoritative endpoint list.
- Preserve the dense desktop layout and design tokens in `styles.css`;
  `design/README.md` and screenshots describe the intended visual language.
  Its original buffer sizes and behavior descriptions can predate implementation.

## Configuration and operational details

- Backend flags override environment defaults; see `server/config.go` and
  `server/README.md`. Default retention is 24h; default stored payload cap is 64 KiB.
- Vite reads configuration from the root `.env` and invoking process; exported
  environment variables take precedence. Never use `VITE_*` for secrets.
- Backend NanoMQ HTTP credentials use `MQTT_API_USER` / `MQTT_API_PASS`.
  Direct-mode metadata uses the same variables in the Vite proxy; credentials
  must never be embedded in browser code.
- Broker metadata is best effort; unavailable values should remain `—`.
- Publishing sends real MQTT messages. Use a deliberate test topic and payload
  for manual checks, rather than the command-like example in the composer.
- Keep generated `app/dist/`, `node_modules/`, backend binaries, SQLite files,
  and WAL sidecars out of commits (existing ignore rules cover project defaults).

## Validation

From `app/`, run `npm run build` (TypeScript + Vite) and `npm run lint` (oxlint).
From `server/`, run `go test ./...`; format changed Go files with `gofmt`.
Existing Go tests cover latest-per-topic storage queries and NanoMQ parsing
without requiring a live broker. No frontend automated test runner is configured.

For UI/data-flow changes, use a reachable test broker to check the relevant
mode: bootstrap and reconnect, topic scope/filter combinations, older history,
REPLACE, pause/resume, persistent inspector selection, and publish feedback as
appropriate. A build alone does not verify connectivity. Report checks that
could not run and why. Keep the READMEs aligned when commands or config change.

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
