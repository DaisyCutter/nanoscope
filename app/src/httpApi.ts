import { HTTP_API_BASE } from './config'
import { store } from './store'
import type { BrokerMetrics, ClientRow } from './types'
import { fmtCount } from './util'

// Polls the NanoMQ HTTP API (v4, EMQX-compatible-ish) for broker/client info.
// Everything is best-effort: missing endpoints or fields degrade to '—'.

async function get(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(HTTP_API_BASE + path)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** /prometheus is the one endpoint that answers in text rather than JSON */
async function getText(path: string): Promise<string> {
  try {
    const res = await fetch(HTTP_API_BASE + path)
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

/**
 * Reads the slice of the Prometheus exposition format NanoMQ emits: "# TYPE"
 * and "# HELP" comments, then bare "name value" lines. No labels, histograms
 * or timestamps appear in its output, so anything that isn't a plain float is
 * skipped rather than guessed at.
 */
function parsePrometheus(body: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const v = Number(line.slice(sp + 1).trim())
    if (!Number.isFinite(v)) continue
    out.set(line.slice(0, sp), v)
  }
  return out
}

/**
 * Reads the /metrics payload: {"metrics":[],"cpuinfo":"1.22%","memory":"5893948"}.
 * Both numbers arrive as strings, and there is no {code, data} envelope, so
 * rows() does not apply. This is the live source for NanoMQ's own process
 * load — the matching /prometheus gauges are frozen on 0.21.9-10.
 */
function readHostMetrics(v: unknown): { cpu: number | null; memory: number | null } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const cpuRaw = s(o.cpuinfo)
  const memRaw = s(o.memory) ?? (n(o.memory) != null ? String(n(o.memory)) : null)
  // truthiness, not != null: s() hands back '' for an empty field, and
  // Number('') is 0 — which would render as a real 0% / 0.0 MB reading
  const cpu = cpuRaw ? Number(cpuRaw.replace('%', '')) : NaN
  const memory = memRaw ? Number(memRaw) : NaN
  return {
    cpu: Number.isFinite(cpu) ? cpu : null,
    memory: Number.isFinite(memory) ? memory : null,
  }
}

function readMetrics(body: string, host: unknown): BrokerMetrics | null {
  const p = parsePrometheus(body)
  const { cpu, memory } = readHostMetrics(host)
  if (p.size === 0 && cpu == null && memory == null) return null
  const v = (k: string): number | null => p.get(k) ?? null
  return {
    msgsIn: v('nanomq_messages_received'),
    msgsOut: v('nanomq_messages_sent'),
    msgsDropped: v('nanomq_messages_dropped'),
    connections: v('nanomq_connections_count'),
    peakClients: v('nanomq_connections_max'),
    subscribers: v('nanomq_subscribers_count'),
    // /prometheus equivalents are frozen on 0.21.9-10; only a fallback
    memory: memory ?? v('nanomq_memory_usage'),
    cpu: cpu ?? v('nanomq_cpu_usage'),
  }
}

type Row = Record<string, unknown>

function rows(v: unknown): Row[] {
  if (!v || typeof v !== 'object') return []
  const data = (v as Row).data
  if (Array.isArray(data)) return data as Row[]
  if (data && typeof data === 'object') {
    const inner = (data as Row).data ?? (data as Row).items
    if (Array.isArray(inner)) return inner as Row[]
  }
  return []
}

const s = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const n = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * Ten years — comfortably past any real broker uptime. NanoMQ 0.21.9-10
 * reports a frozen "5891960 Hours" (~672 years), identical on every poll,
 * which used to render as a seven-digit day count in the header.
 */
const UPTIME_SANE_DAYS = 3650

// NanoMQ returns strings like "15 Hours, 4 minutes, 19 seconds". Returns null
// when the broker reports something implausible, which the UI shows as —.
function parseUptime(raw: string): string | null {
  const days = /(\d+)\s*day/i.exec(raw)
  const hours = /(\d+)\s*hour/i.exec(raw)
  const mins = /(\d+)\s*minute/i.exec(raw)
  let d = days ? +days[1] : 0
  let h = hours ? +hours[1] : 0
  const m = mins ? +mins[1] : 0
  d += Math.floor(h / 24)
  h = h % 24
  if (d > UPTIME_SANE_DAYS) return null
  return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

async function poll(): Promise<void> {
  // /metrics goes first and alone. NanoMQ computes cpuinfo in
  // update_process_info(), which both /metrics and /prometheus call through
  // one pair of shared static baselines, so the percentage covers the interval
  // since either endpoint was last hit. Fired together, the second to land
  // divides by a near-zero window and returns quantised nonsense (0%, 14.29%,
  // 25%); fetched first, /metrics gets the whole poll interval.
  const host = await get('/metrics')

  const [brokers, clients, subs, nodes, prom] = await Promise.all([
    get('/brokers'),
    get('/clients'),
    get('/subscriptions'),
    get('/nodes'),
    getText('/prometheus'),
  ])

  const patch: Partial<import('./types').State> = {}

  const b = rows(brokers)[0]
  if (b) {
    const up = s(b.uptime)
    if (up) patch.uptime = parseUptime(up)
  }

  const node = rows(nodes)[0]
  if (node) {
    patch.brokerVersion = s(node.version)
    patch.nodeStatus = s(node.node_status)
  }

  const metrics = readMetrics(prom, host)
  if (metrics) patch.metrics = metrics

  const subCounts = new Map<string, number>()
  for (const r of rows(subs)) {
    const cid = s(r.clientid) ?? s(r.client_id)
    if (cid) subCounts.set(cid, (subCounts.get(cid) ?? 0) + 1)
  }

  const clientRows = rows(clients)
  if (clientRows.length || clients) {
    const mapped: ClientRow[] = clientRows.map((r) => {
      const id = s(r.client_id) ?? s(r.clientid) ?? '?'
      const ip = s(r.ip_address) ?? s(r.ipaddress)
      const port = n(r.port)
      const recv = n(r.recv_msg) ?? n(r.recv_cnt)
      const send = n(r.send_msg) ?? n(r.send_cnt)
      const connState = s(r.conn_state)
      const connected = connState ? connState === 'connected' : r.connected !== false
      return {
        id,
        addr: ip ? ip + (port ? ':' + port : '') : '—',
        subs: subCounts.get(id) ?? n(r.subscriptions_cnt) ?? '—',
        io: recv != null || send != null ? `${fmtCount(recv ?? 0)}/${fmtCount(send ?? 0)}` : '—',
        keepalive: n(r.keepalive) != null ? r.keepalive + 's' : '—',
        state: connected ? 'CONN' : 'IDLE',
      }
    })
    patch.clients = mapped
    patch.clientsCount = clientRows.length || store.state.clientsCount
  }

  if (Object.keys(patch).length) store.set(patch as Partial<import('./types').State>)
}

export function startPolling(): void {
  void poll()
  setInterval(() => void poll(), 5000)
}
