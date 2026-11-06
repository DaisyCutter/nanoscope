import { HISTORY_PAGE, LATEST_CAP, SERVER_BASE, serverWsUrl } from '../config'
import { store } from '../store'
import type { Bootstrap, ClientRow, Msg, ServerStats } from '../types'

// Adapter for the Go backend. Unlike live mode, the backend has been
// subscribed to the broker the whole time the browser was closed, so load
// starts from the full retention window rather than from empty.

interface Frame {
  t: 'msgs' | 'stats'
  msgs?: Msg[]
  stats?: ServerStats
}

let ws: WebSocket | null = null
let retry = 0

async function get<T>(path: string): Promise<T> {
  const res = await fetch(SERVER_BASE + path)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

async function bootstrap(): Promise<void> {
  try {
    store.hydrate(await get<Bootstrap>(`/bootstrap?limit=${HISTORY_PAGE}`))
  } catch (err) {
    store.set({ conn: 'offline', connError: 'backend unreachable — ' + String(err) })
  }
}

function openSocket(): void {
  ws = new WebSocket(serverWsUrl())

  ws.onopen = () => {
    retry = 0
    store.set({ connError: null })
  }

  ws.onmessage = (ev) => {
    let f: Frame
    try {
      f = JSON.parse(ev.data as string) as Frame
    } catch {
      return
    }
    if (f.t === 'msgs' && f.msgs) store.ingestServer(f.msgs)
    else if (f.t === 'stats' && f.stats) store.applyServerStats(f.stats)
  }

  ws.onerror = () => ws?.close()

  ws.onclose = () => {
    store.set({ conn: 'reconnecting' })
    // exponential backoff, capped — the backend keeps recording either way,
    // so a slow reconnect costs us live updates but never history
    const delay = Math.min(1000 * 2 ** retry++, 15_000)
    window.setTimeout(openSocket, delay)
  }
}

async function pollClients(): Promise<void> {
  try {
    store.set({ clients: await get<ClientRow[]>('/clients') })
  } catch {
    // backend down; the socket's reconnect loop already surfaces that
  }
}

export function connect(): void {
  void bootstrap().then(openSocket)
  void pollClients()
  window.setInterval(() => void pollClients(), 5000)
  store.onScopeChange = (scope) => void loadScope(scope)
  store.onLatestNeeded = () => void loadLatest()
}

function scopedQuery(extra: Record<string, string>): string {
  const qs = new URLSearchParams({ limit: String(HISTORY_PAGE), ...extra })
  if (store.state.scope) qs.set('scope', store.state.scope)
  return qs.toString()
}

/** page one window further back, from the oldest message currently held */
export async function loadOlder(): Promise<void> {
  if (store.state.loadingOlder || store.state.exhausted) return
  const before = store.oldestLoadedId()
  if (!before) return

  store.beginLoadOlder()
  try {
    store.appendOlder(await get<Msg[]>(`/messages?${scopedQuery({ before })}`))
  } catch {
    store.set({ loadingOlder: false })
  }
}

/**
 * Re-query when the scope changes. Without this, scoping to a quiet topic would
 * show only what happens to be in the loaded window — even though the backend
 * still holds that topic's full retention window.
 */
export async function loadScope(scope: string | null): Promise<void> {
  store.beginLoadOlder()
  try {
    const qs = new URLSearchParams({ limit: String(HISTORY_PAGE) })
    if (scope) qs.set('scope', scope)
    store.replaceWindow(await get<Msg[]>(`/messages?${qs.toString()}`))
  } catch {
    store.set({ loadingOlder: false })
  }
}

// A replace-mode query can be superseded before it lands — toggling two qos
// chips in quick succession fires two — and the answers are not guaranteed to
// come back in order, so only the newest one is allowed to win.
let latestSeq = 0

/**
 * Fetch one row per topic across the whole retention window, which is what
 * replace mode shows. The filters go to the backend rather than being applied
 * to the result, so that "latest" is the latest *matching* message of each
 * topic — see the toggles in store.ts.
 */
export async function loadLatest(): Promise<void> {
  const seq = ++latestSeq
  const qs = new URLSearchParams({ limit: String(LATEST_CAP) })
  if (store.state.scope) qs.set('scope', store.state.scope)
  const qos = ([0, 1, 2] as const).filter((n) => store.state.qos[n])
  if (qos.length < 3) qs.set('qos', qos.join(','))
  if (store.state.retainedOnly) qs.set('retained', '1')

  try {
    const msgs = await get<Msg[]>(`/latest?${qs.toString()}`)
    if (seq === latestSeq) store.setLatest(msgs)
  } catch {
    if (seq === latestSeq) store.setLatest([])
  }
}

export async function publish(
  topic: string,
  body: string,
  qos: 0 | 1 | 2,
  retain: boolean,
): Promise<void> {
  try {
    const res = await fetch(SERVER_BASE + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, payload: body, qos, retain }),
    })
    const r = (await res.json()) as { ok: boolean; detail: string }
    store.set({ pubStatus: { text: (r.ok ? '✓ ' : '✗ ') + r.detail, ok: r.ok } })
  } catch (err) {
    store.set({ pubStatus: { text: '✗ ' + String(err), ok: false } })
  }
}
