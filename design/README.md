# Handoff: NanoMQ MQTT Explorer Dashboard ("Nanoscope")

## Overview
A single-screen, full-bleed operator console for exploring and debugging MQTT traffic on a
NanoMQ broker. Primary job: **browse the topic tree, scope the live message stream to a topic,
and inspect JSON payloads**. Secondary: broker health at a glance, connected clients, and a
publish composer for test messages. Audience is a mixed technical team (firmware, platform, data).
Target scale: hundreds of topics / ~150 concurrent clients.

## About the Design Files
`MQTT Dashboard.dc.html` in this bundle is a **design reference created in HTML** — a working
prototype of the intended look and behavior, driven by simulated data. It is **not production
code to copy**. The task is to **recreate this design in the target codebase's existing
environment** (React, Vue, Svelte, etc.) using its established patterns, state layer, and
component library, wired to a real MQTT source (MQTT-over-WebSocket via mqtt.js, or a
server-side bridge streaming over SSE/WebSocket). If no frontend environment exists yet, pick
the most appropriate framework for the project and implement it there.

The file is self-contained: open it in a browser to see the design running. Its logic is a
single class at the bottom of the file; markup is the template above it. Simulated-data helpers
(`TOPICS`, `payloadFor`, `make()`, the `setInterval` tick) exist **only** to animate the
prototype — replace them entirely with the real feed.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, density, and interactions. Recreate
pixel-accurately, substituting the codebase's equivalents where they exist. Every value below is
exact and taken from the prototype.

---

## Global frame

- Root: `height: 100vh`, `min-height: 640px`, `min-width: 1200px`, `overflow: hidden`.
  Authored for 1440×900. Not responsive below 1200px by design (desktop operator tool).
- Root grid: `grid-template-rows: 40px auto 1fr` → header / stat strip / main.
- Base type: `'JetBrains Mono'` 11px, `letter-spacing: .01em`, color `#c8d4e2`, bg `#06080b`.
- Wordmark only: `'Space Grotesk'` 700.
- Panel separation is done with 1px gaps in a grid whose background is `#111925` (hairline rules),
  plus `1px solid #101823` internal dividers. No border radius anywhere; no shadows except two
  neon glows (wordmark text-shadow, publish button).
- Scrollbars: 8px, thumb `#1b2531`, transparent track.

### Header (40px)
`display:flex; align-items:center; gap:14px; padding:0 12px; border-bottom:1px solid #121a24;`
`background: linear-gradient(180deg,#0a0e14,#070a0f)`

| Element | Spec |
|---|---|
| Wordmark `NANOSCOPE` | Space Grotesk 700, 14px, `letter-spacing:.14em`, `#5ef2ff`, `text-shadow:0 0 14px rgba(94,242,255,.45)` |
| `MQTT 5.0` | 9px, `.18em`, `#3d4d5f` |
| Broker chip | `padding:3px 8px; border:1px solid #16303c; background:#0a141a; color:#7fe9ff`; contains a 5px `#4dff9f` dot with `blip` animation, the URL `nanomq://edge-01.fleet.internal:1883`, a `#31485a` pipe, and `TLS` in `#4a6076` |
| Tabs (right-aligned, `margin-left:auto`, `gap:2px`) | STREAM / TOPICS / CLIENTS / PUBLISH. 10px, `.18em`, `padding:4px 12px`. Inactive: transparent bg, transparent border, `#5c7086`. Active: bg `#0d2b33`, border `1px solid #1d6b7d`, color `#7fe9ff`. Hover: `#dff6ff` |
| Right meta | `up 31d 04:12` (`#4a6076`), `/` (`#1c2836`), wall clock `HH:MM:SS` (`#9fb2c6`), 10px |

### Stat strip
`grid-template-columns: repeat(6,1fr); gap:1px; background:#111925; border-bottom:1px solid #121a24`.
Each cell: bg `#080b10`, `padding:7px 10px`. Label 9px `.16em` `#42566a`; value 19px weight 500,
`line-height:1`.

1. **MSG / SEC** — value `#5ef2ff` + 96×20 sparkline, stroke `#5ef2ff`, width 1, opacity .85
2. **TOTAL RECEIVED** — `#dbe8f5`, thousands-separated
3. **TOPICS ACTIVE** — `#dbe8f5`, with `/ 418` suffix in 10px `#3d4d5f`
4. **CLIENTS** — `142` in `#b6ff5c`, ` conn` suffix
5. **INFLIGHT / QUEUED** — `34 / 512`
6. **DROPPED (1h)** — `7` in `#ff5ec8` + sparkline stroke `#ff5ec8`, opacity .7

Sparklines are `<svg preserveAspectRatio="none">` polylines over a rolling 40-bucket array,
normalized to the array max, one new bucket per tick.

### Main
`grid-template-columns: 250px 1fr 340px; gap:1px; background:#111925; overflow:hidden`.

---

## Left rail (250px)
`grid-template-rows: auto 1fr auto auto` — search / tree / saved filters / alert rules.

**Search** (`padding:7px 8px`, bottom divider): `▸` caret in `#31485a` + input.
Input: bg `#0b1119`, border `1px solid #15202c`, 10px, `padding:4px 6px`, color `#cfe0f0`,
focus border `#1d4f60`, placeholder `filter topics  fleet/+/temp`.

**Topic tree** (scrolls, `padding:4px 0`): flattened rows built from `/`-split topic paths.
Row: `display:flex; align-items:center; gap:6px; padding:2px 8px 2px calc(6px + depth*11px)`.
- Caret column 9px wide, `#33475a`: `▾` open branch, `▸` collapsed, `·` leaf
- Leaf status dot 4px round: `#4dff9f` if >6 recent msgs, `#2f7a5a` if any, `#233240` if none
- Label truncates with ellipsis; branch color `#6e849a`, leaf `#9fb2c6`
- Message count right-aligned, 9px `#37485a`
- Selected (scoped): color `#7fe9ff`, bg `#0d2b33`, `border-left:2px solid #5ef2ff`
- Hover: bg `#0d1621`
- Click branch = expand/collapse **and** scope; click leaf = toggle scope. Typing in the search
  box force-expands all branches and shows nodes whose subtree matches.

**Saved filters** (top divider, `padding:7px 8px`): section label, then rows
`display:flex; justify-content:space-between; padding:3px 6px; border:1px solid #131c26`,
color `#7d92a7`; selected gets border `#1d6b7d`, bg `#0d2b33`, color `#7fe9ff`. Hit count 9px `#37485a`.
Entries: `fleet/+/sensor/#` 412 · `$SYS/broker/#` 88 · `ota/progress/+` 24 · `fleet/+/+/cmd/ack` 61.
Clicking one writes its expression into the topic search box (toggles off if already active).

**Alert rules**: 5px dot + name (`#8ba0b5`, truncating) + state badge, 9px.
`temp_high · > 28°C 5m` **FIRING** `#ff5ec8` (dot animates `blip`) ·
`co2_high · > 1000ppm` **ARMED** `#4dff9f` ·
`gw offline · no hb 90s` **ARMED** `#4dff9f` ·
`vib_alarm · rms > 6` **MUTED** `#5c7086`.

---

## Center pane (1fr)
`grid-template-rows: auto 1fr`.

### Toolbar (all tabs share it)
`padding:6px 8px; gap:6px; flex-wrap:wrap; border-bottom:1px solid #101823`.
- Scope label: `▸ ALL TOPICS` or `▸ <scoped topic>`, 9px `.16em`, `#5ef2ff`
- `│` divider `#1c2836`
- Chips `QOS 0` / `QOS 1` / `QOS 2` and `RETAINED` — shared chip style:
  off `transparent / 1px #15202c / #4d6379`; on `#0d2b33 / 1px #1d6b7d / #7fe9ff`;
  9px `.12em`, `padding:3px 7px`; hover border `#1d4f60`
- Right group: `N shown` (9px `#37485a`), `CLEAR` (ghost button), pause toggle —
  running: `❚❚ PAUSE` bg `#0d2b33` border `#1d6b7d` color `#7fe9ff`;
  paused: `▶ RESUME` bg `#3a1230` border `#7d1d5e` color `#ff9fe0`

### Tab: STREAM (default)
Header row `grid-template-columns: 92px 34px 26px 1fr 62px; gap:8px; padding:4px 10px`,
bg `#0a0e14`, 9px `.14em` `#3a4c5e`: TIME · QOS · R · TOPIC · PAYLOAD · BYTES (right).

Message rows, same grid, `padding:3px 10px`, `border-bottom:1px solid #0c1420`:
- Time `HH:MM:SS.mmm` in `#556c82`
- QoS `Q0/Q1/Q2` — Q0 `#4d6379`, Q1 `#ffc95e`, Q2 `#ff9fe0`
- Retain flag `R` `#b6ff5c`, else `·` `#22303e`
- Topic `#7fe9ff`, separator ` ▸ ` `#26374a`, payload preview (first 90 chars of the raw JSON) `#93a8bd`, whole cell truncates
- Bytes right-aligned `#3a4c5e`
- Hover bg `#0e1826`; selected bg `#102030` + `border-left:2px solid #5ef2ff`
- Newest row plays a 450ms ease-out entry: opacity 0→1, `translateY(-6px)→0`,
  background `rgba(94,242,255,.14)`→transparent.
  *Implementation note:* the prototype alternates between two identical keyframe names
  (`rowInA`/`rowInB`) so the animation restarts on each new message despite index-keyed
  reconciliation. In a real app, key rows by message id and animate on mount instead.
- Rendering caps at 120 rows; buffer caps at 220 messages. For a real fleet, virtualize.

### Tab: TOPICS
Grid `1fr 42px 34px 66px 104px 78px`. Columns: TOPIC · QOS · RET · MSG/MIN (right) ·
THROUGHPUT 5m (104×14 sparkline, stroke `#5ef2ff`, opacity .75) · LAST SEEN (right, `#4d6379`,
`Ns ago` / `Nm ago`). Topic text `#a8bdd2`. Row click scopes that topic **and** jumps to STREAM.
Rows are filtered by the left-rail search box.

### Tab: CLIENTS
Grid `1fr 118px 52px 60px 62px 70px`: CLIENT ID · ADDRESS (`#556c82`) · SUBS · TX/RX ·
KEEPALIVE · STATE (right-aligned; `CONN` `#4dff9f`, `FLAP` `#ff5ec8`, `IDLE` `#ffc95e`).
14 sample rows (gateways, ESP sensors, meters, `rules-engine`, `ota-svc`). Read-only in v1.

### Tab: PUBLISH
`padding:14px; gap:12px; max-width:720px`.
- **TOPIC** — full-width input, 11px, text `#7fe9ff`, same input styling as search
- Row: **QOS** chips `0/1/2` (single select) · **RETAIN** toggle chip · `N BYTES` counter
- **PAYLOAD · JSON** — textarea, height 190px, `line-height:1.6`, text `#b6ff5c`,
  `resize:vertical`, `spellcheck=false`
- `PUBLISH ▸` — bg `#0d2b33`, border `1px solid #1d6b7d`, `#7fe9ff`, 10px `.18em`,
  `padding:7px 20px`, `box-shadow:0 0 18px rgba(94,242,255,.18)`, hover bg `#12414d`
- Result line in `#4dff9f`: `✓ sent · packet 0x4a1c · qos1` (real impl: show the broker's PUBACK/
  PUBCOMP or an error in `#ff5ec8`)
- Defaults shown: topic `fleet/eu-west/gw-01/cmd`, QoS 1, body `{"cmd":"reboot","delay_s":5,"reason":"ota-rollback"}` pretty-printed

---

## Right rail — Payload inspector (340px)
`grid-template-rows: auto auto 1fr auto`.

1. **Header** — `PAYLOAD INSPECTOR` 9px `.16em` `#5ef2ff`; message id right, 9px `#37485a`
2. **Meta block** (`padding:8px 10px`, bottom divider) — topic in `#7fe9ff`, `word-break:break-all`;
   then a `auto 1fr` grid with `gap:2px 10px`, labels `#4d6379` 10px, values `#a8bdd2`:
   received (`HH:MM:SS.mmm`), qos, retain, bytes, client
3. **JSON body** (scrolls, `padding:8px 10px`, `line-height:1.65`) — `JSON.stringify(v,null,2)`
   rendered one `display:flex` row per line, each token a span with `white-space:pre`:
   - keys `#5ef2ff` · strings `#ff9fe0` · numbers `#b6ff5c` · true/false/null `#ffc95e`
   - braces, brackets, colons, commas, indent `#2f4256` · fallback `#c8d4e2`
   - **Do not** put `white-space:pre` on the line container — inter-tag whitespace leaks in.
     Use a real syntax highlighter or a token array in the target app.
4. **Topic history · last 6** — timestamp `#3f5266` 10px + 60-char preview `#5c7086` 10px,
   hover `#cfe0f0`, click loads that message into the inspector

---

## Interactions & Behavior
- **Scope**: selecting a tree node or topic row filters the stream to that exact topic and its
  descendants (`topic === scope || topic.startsWith(scope + '/')`). Clicking the active node clears it.
- **Filters compose**: scope ∧ QoS set ∧ retained-only ∧ `$SYS` visibility.
- **Search** filters the tree (and TOPICS table) by substring; a branch stays visible if any
  descendant matches. Real impl should also accept MQTT wildcard syntax (`+`, `#`) as used in the
  saved filters.
- **Pause** freezes ingestion; the clock keeps running. `CLEAR` empties the buffer.
- **Selection** persists as messages arrive; the inspector never auto-jumps to the newest message.
- **Live cues**: entry animation on the newest row; `blip` keyframe (1.6s / 1s, opacity 1→.28 with
  a `currentColor` glow) on the broker dot and firing alerts; sparklines shift one bucket per tick.
- **Prototype tick** is 640ms (tweakable 150–2000ms) producing 1–3 messages. Real feed should
  batch DOM updates (e.g. rAF-coalesced, ~10 Hz max) rather than re-render per message.
- No hover/focus states beyond those listed; no loading or error states are designed yet —
  suggest: broker-disconnected banner reusing the `#ff5ec8` accent, and a skeleton state for
  the tree on first connect.

## State Management
| State | Type | Notes |
|---|---|---|
| `msgs` | ring buffer, cap 220 | `{id, ts, topic, qos, retain, body, json, bytes, client}` |
| `tab` | `'stream'\|'topics'\|'clients'\|'publish'` | |
| `sel` | message id | inspector target |
| `scope` | topic path \| null | set by tree/topic-table click |
| `filter` | string | tree search / saved filter |
| `expanded` | `{ [topicPrefix]: boolean }` | tree open state |
| `qos` | `{0,1,2: boolean}` | chip toggles |
| `retainedOnly`, `paused` | boolean | |
| `spark`, `drops` | number[40] | rolling throughput buckets |
| `rate`, `total`, `clock` | number/string | header + stat strip |
| `pubTopic`, `pubQos`, `pubRetain`, `pubBody`, `pubStatus` | composer form | |

Data needs from the backend: subscribe (`#` or a user-chosen wildcard set), per-message
`{topic, qos, retain, payload, ts, clientId}`, broker `$SYS` counters for the stat strip,
a client list endpoint, and a publish endpoint. Topic-tree nodes and counts are derived
client-side from observed topics.

## Design Tokens
**Backgrounds** `#06080b` page · `#080b10` panel · `#0a0e14` table header · `#0b1119` input ·
`#0d2b33` active/accent fill · `#102030` selected row · `#0e1826` hover row · `#0d1621` hover tree ·
`#3a1230` paused fill

**Lines** `#111925` grid hairline · `#121a24` header rule · `#101823` panel divider ·
`#0c1420` row rule · `#15202c` control border · `#1d6b7d` accent border · `#1d4f60` focus/hover border ·
`#16303c` chip border · `#131c26` filter border · `#7d1d5e` paused border

**Text** `#c8d4e2` base · `#dbe8f5` numeric emphasis · `#a8bdd2` secondary · `#9fb2c6` · `#8ba0b5` ·
`#7d92a7` · `#5c7086` muted · `#556c82` timestamps · `#4d6379` labels · `#42566a` section labels ·
`#3a4c5e` / `#37485a` / `#31485a` / `#33475a` faint · `#26374a` / `#22303e` / `#1c2836` hairline glyphs

**Accents** cyan `#5ef2ff` (primary) · pale cyan `#7fe9ff` (accent text) · `#b4faff` link hover ·
lime `#b6ff5c` (numbers, retain) · green `#4dff9f` (healthy) · amber `#ffc95e` (warn, QoS1) ·
magenta `#ff5ec8` (error/critical) · pink `#ff9fe0` (strings, QoS2)

**Type scale** 19px/500 stat values · 14px/700 wordmark · 11px/400 body & rows · 10px meta/inputs ·
9px labels & chips. Tracking: `.12em` chips, `.14em` table headers, `.16em` section labels,
`.18em` tabs, `.14em` wordmark.

**Spacing** 2 / 3 / 4 / 6 / 7 / 8 / 10 / 12 / 14px. Radius: 0 everywhere except 50% status dots.
**Shadows/glows** `0 0 14px rgba(94,242,255,.45)` wordmark · `0 0 18px rgba(94,242,255,.18)` publish
button · `0 0 6px currentColor` on blipping dots.

**Fonts** JetBrains Mono 300/400/500/700 and Space Grotesk 500/700 (Google Fonts).

**Keyframes** `rowInA`/`rowInB` (450ms ease-out entry) · `blip` (1–1.6s ease-in-out infinite).

## Assets
None. No images, no icon set — all glyphs are Unicode characters already in the markup
(`▸ ▾ · ▪ │ ❚❚ ✓ ▶`). If the target codebase has an icon library, swap them for real icons at
the same optical size (~10px) and colors.

## Screenshots
`screenshots/01-stream.png` · `02-topics.png` · `03-clients.png` · `04-publish.png` —
captured from the prototype at 1440-wide, one per tab, left rail and inspector visible in each.

## Files
- `MQTT Dashboard.dc.html` — the complete hi-fi prototype (markup + logic + simulated feed).
  Open directly in a browser.
