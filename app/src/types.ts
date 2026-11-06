import type { AlertRule } from './alerts'

export interface Msg {
  id: string
  ts: number
  topic: string
  qos: 0 | 1 | 2
  retain: boolean
  /** raw payload decoded as utf-8 */
  payload: string
  bytes: number
  /** sender client id when the broker/publisher exposes it (MQTT 5 user property) */
  client: string | null
}

export interface TopicStat {
  path: string
  qos: 0 | 1 | 2
  retain: boolean
  lastTs: number
  total: number
  /** 20 buckets x 15s = 5 minutes of throughput */
  buckets: number[]
  bucketStart: number
}

export interface ClientRow {
  id: string
  addr: string
  subs: number | string
  io: string
  keepalive: string
  state: 'CONN' | 'FLAP' | 'IDLE'
}

export interface AlertView {
  id: string
  name: string
  detail: string
  state: 'FIRING' | 'ARMED' | 'MUTED'
}

/** one minute of throughput, as stored by the backend; 1440 cover 24h */
export interface Bucket {
  minute: number
  count: number
  bytes: number
}

/** per-topic aggregate over the whole retention window, from the backend */
export interface WireTopic {
  path: string
  qos: 0 | 1 | 2
  retain: boolean
  lastTs: number
  total: number
}

/**
 * Counters scraped from the broker's /prometheus endpoint. MQTT never tells us
 * how many messages the broker *dropped*, and $SYS only gives a running total
 * since the tab opened; these survive a reload.
 *
 * Every field is nullable because "the broker didn't report this" and "the
 * broker reported zero" render differently (— versus 0).
 */
export interface BrokerMetrics {
  msgsIn: number | null
  msgsOut: number | null
  msgsDropped: number | null
  connections: number | null
  peakClients: number | null
  subscribers: number | null
  memory: number | null
  cpu: number | null
}

export interface ServerStats {
  totalStored: number
  topicsActive: number
  rate: number
  oldestTs: number
  retentionMs: number
  uptime: string
  clientsCount: number | null
  brokerConn: Conn
  version: string
  nodeStatus: string
  metrics: BrokerMetrics | null
}

/** the single payload fetched on load: 24h of aggregates + one window of messages */
export interface Bootstrap {
  stats: ServerStats
  topics: WireTopic[]
  buckets: Bucket[]
  messages: Msg[]
  brokerDisplay: string
}

export type Tab = 'stream' | 'topics' | 'clients' | 'publish'
export type Conn = 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface State {
  conn: Conn
  brokerUrl: string
  brokerDisplay: string
  connError: string | null

  msgs: Msg[] // newest first, capped
  topics: Map<string, TopicStat>

  tab: Tab
  sel: string | null
  scope: string | null
  filter: string
  expanded: Record<string, boolean>
  qos: Record<0 | 1 | 2, boolean>
  retainedOnly: boolean
  /** replace mode: show only the latest message per topic */
  latestOnly: boolean
  /**
   * One row per topic across the backend's whole retention window, for replace
   * mode. The loaded window only reaches back as far as it has paged, so a
   * topic that last published hours ago is absent from it; this fills those in.
   * Empty in live mode, where the ring buffer is all there is.
   */
  latest: Msg[]
  /** true while the replace-mode snapshot is being re-queried */
  latestLoading: boolean
  paused: boolean

  spark: number[]
  drops: number[]
  rate: number
  totalSession: number
  sysTotal: number | null
  clientsCount: number | null
  dropped1h: number | null
  uptime: string | null
  /** broker software version from /nodes; null until the first poll answers */
  brokerVersion: string | null
  nodeStatus: string | null
  /** latest /prometheus scrape, null when the broker doesn't serve it */
  metrics: BrokerMetrics | null
  /** rolling 1 Hz samples of broker CPU %, for the stat-strip sparkline */
  cpuHist: number[]
  clock: string

  /** minute-resolution throughput across the whole retention window */
  history: Bucket[]
  /** retention horizon reported by the backend, ms; 0 in live mode */
  retentionMs: number
  /** timestamp of the oldest stored message; 0 when nothing is stored */
  oldestTs: number
  /** how many of the loaded messages the stream table renders */
  renderCap: number
  /** true while a "load older" page is in flight */
  loadingOlder: boolean
  /** true once the backend has no more history behind the current window */
  exhausted: boolean

  clients: ClientRow[]
  alerts: AlertView[]
  alertRules: AlertRule[]

  pubTopic: string
  pubQos: 0 | 1 | 2
  pubRetain: boolean
  pubBody: string
  pubStatus: { text: string; ok: boolean } | null
}
