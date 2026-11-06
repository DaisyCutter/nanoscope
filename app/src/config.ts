declare const __BROKER_DISPLAY__: string

// Broker WebSocket URL: ?broker= query param overrides; default goes through the
// dev server's WS→TCP bridge at /mqtt (see vite.config.ts).
export function brokerUrl(): string {
  const qp = new URLSearchParams(window.location.search).get('broker')
  if (qp) return qp
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/mqtt`
}

/** what the header chip shows — the real broker address, not the bridge */
export function brokerDisplay(): string {
  const qp = new URLSearchParams(window.location.search).get('broker')
  return qp ?? __BROKER_DISPLAY__
}

// NanoMQ HTTP API; the dev proxy attaches credentials server-side.
export const HTTP_API_BASE = '/hapi/api/v4'

export const SUBSCRIPTIONS = ['#', '$SYS/#']

export const MSG_CAP = 880
export const RENDER_CAP = 120
export const SPARK_BUCKETS = 40
export const TOPIC_BUCKETS = 20 // x 15s = 5 minutes
export const TOPIC_BUCKET_MS = 15_000

export const SAVED_FILTERS = ['fleet/+/sensor/#', '$SYS/broker/#', 'ota/progress/+', 'fleet/+/+/cmd/ack']

// ---- data source selection ----
// 'server' talks to the Go backend and gets the full retention window of
// history on load. 'live' is the original browser-direct MQTT connection —
// no persistence, nothing before the moment the tab opened.
declare const __DEFAULT_MODE__: string

export type SourceMode = 'live' | 'server'

export function sourceMode(): SourceMode {
  const qp = new URLSearchParams(window.location.search).get('mode')
  if (qp === 'live' || qp === 'server') return qp
  return __DEFAULT_MODE__ === 'live' ? 'live' : 'server'
}

/** Go backend REST base. The vite dev server proxies this through. */
export const SERVER_BASE = '/api'

export function serverWsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${SERVER_BASE}/live`
}

/**
 * In server mode the browser holds a sliding window over the backend's history,
 * not the whole thing — 24h of raw messages would be hundreds of thousands of
 * rows. HISTORY_PAGE is one "load older" step, HISTORY_CAP the ceiling we keep
 * in memory before older pages are dropped off the end.
 */
export const HISTORY_PAGE = 880
export const HISTORY_CAP = 5000

/**
 * Ceiling on the replace-mode snapshot. Its size is bounded by the number of
 * distinct topics rather than by traffic, so it gets its own limit instead of
 * a history page's.
 */
export const LATEST_CAP = 5000
