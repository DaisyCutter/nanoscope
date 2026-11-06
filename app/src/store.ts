import { useSyncExternalStore } from 'react'
import type { Bootstrap, Msg, ServerStats, State, Tab, TopicStat } from './types'
import { fairShareTrim } from './budget'
import {
  HISTORY_CAP,
  HISTORY_PAGE,
  MSG_CAP,
  RENDER_CAP,
  SPARK_BUCKETS,
  TOPIC_BUCKETS,
  TOPIC_BUCKET_MS,
  brokerDisplay,
  brokerUrl,
  sourceMode,
} from './config'
import {
  type AlertRule,
  alertStates,
  loadRules,
  newRule,
  observeAlerts,
  reseedAlerts,
  saveRules,
} from './alerts'

const FLUSH_MS = 100 // coalesce UI updates to ~10 Hz

class Store {
  state: State = {
    conn: 'connecting',
    brokerUrl: brokerUrl(),
    brokerDisplay: brokerDisplay(),
    connError: null,
    msgs: [],
    topics: new Map(),
    tab: 'stream',
    sel: null,
    scope: null,
    filter: '',
    expanded: {},
    qos: { 0: true, 1: true, 2: true },
    retainedOnly: false,
    latestOnly: false,
    latest: [],
    latestLoading: false,
    paused: false,
    spark: Array(SPARK_BUCKETS).fill(0),
    drops: Array(SPARK_BUCKETS).fill(0),
    rate: 0,
    totalSession: 0,
    sysTotal: null,
    clientsCount: null,
    dropped1h: null,
    uptime: null,
    brokerVersion: null,
    nodeStatus: null,
    metrics: null,
    cpuHist: Array(SPARK_BUCKETS).fill(0),
    clock: new Date().toTimeString().slice(0, 8),
    history: [],
    retentionMs: 0,
    oldestTs: 0,
    renderCap: RENDER_CAP,
    loadingOlder: false,
    exhausted: true,
    clients: [],
    alerts: [],
    alertRules: loadRules(),
    pubTopic: 'fleet/eu-west/gw-01/cmd',
    pubQos: 1,
    pubRetain: false,
    pubBody: '{\n  "cmd": "reboot",\n  "delay_s": 5,\n  "reason": "ota-rollback"\n}',
    pubStatus: null,
  }

  /**
   * How many messages we keep client-side. Live mode is a small ring; server
   * mode is a sliding window over the backend's retention period, grown by
   * paging older messages in. Once the budget is full it is shared out per
   * topic rather than by arrival order — see budget.ts.
   */
  private msgCap = sourceMode() === 'server' ? HISTORY_CAP : MSG_CAP

  /**
   * Oldest message id we have *fetched*, which is not the oldest we still
   * hold: fair-share eviction can drop the tail of a chatty topic right after
   * a page arrives. Paging from what remains would re-request the same rows
   * forever, so the cursor advances with the fetch, not with the buffer.
   */
  private cursor: string | null = null

  private listeners = new Set<() => void>()
  private seq = 0
  private pending: Msg[] = []
  private secondCount = 0
  private lastDropped: number | null = null
  private flushTimer: number | null = null

  constructor() {
    setInterval(() => this.tick(), 1000)
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSnapshot = () => this.state

  /** immediate update for UI interactions */
  set(partial: Partial<State>) {
    this.state = { ...this.state, ...partial }
    this.emit()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /** batched update for the message firehose */
  private scheduleFlush() {
    if (this.flushTimer != null) return
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
  }

  private flush() {
    if (!this.pending.length) return
    const add = this.pending
    this.pending = []
    const msgs = fairShareTrim(add.concat(this.state.msgs), this.msgCap)
    this.state = {
      ...this.state,
      msgs,
      totalSession: this.state.totalSession + add.length,
      alerts: alertStates(this.state.alertRules, Date.now()),
    }
    this.emit()
  }

  ingest(m: Omit<Msg, 'id'>) {
    // track per-topic stats even while paused? No — pause freezes ingestion entirely.
    if (this.state.paused) return
    this.seq++
    const msg: Msg = { ...m, id: 'm' + String(this.seq).padStart(6, '0') }
    this.secondCount++

    // $SYS counters feed the stat strip rather than only the stream
    if (msg.topic.startsWith('$SYS')) this.consumeSys(msg)

    observeAlerts(msg, this.state.alertRules)

    this.trackTopic(msg)
    this.pending.unshift(msg)
    if (this.pending.length > this.msgCap) this.pending.length = this.msgCap
    this.scheduleFlush()

    // default-select the first message so the inspector isn't empty
    if (this.state.sel == null && this.pending.length === 1 && this.state.msgs.length === 0) {
      this.state = { ...this.state, sel: msg.id }
    }
  }

  private trackTopic(m: Msg) {
    const now = m.ts
    let t = this.state.topics.get(m.topic)
    if (!t) {
      t = {
        path: m.topic,
        qos: m.qos,
        retain: m.retain,
        lastTs: now,
        total: 0,
        buckets: Array(TOPIC_BUCKETS).fill(0),
        bucketStart: now,
      }
      this.state.topics.set(m.topic, t)
      this.autoExpand(m.topic)
    }
    // roll the 15s buckets forward
    const shift = Math.floor((now - t.bucketStart) / TOPIC_BUCKET_MS)
    if (shift > 0) {
      t.buckets = t.buckets.slice(Math.min(shift, TOPIC_BUCKETS)).concat(Array(Math.min(shift, TOPIC_BUCKETS)).fill(0))
      t.bucketStart += shift * TOPIC_BUCKET_MS
    }
    t.buckets[t.buckets.length - 1]++
    t.total++
    t.lastTs = now
    t.qos = m.qos
    t.retain = m.retain
  }

  /** expand the first two levels of newly-observed topics so the tree isn't a wall of collapsed roots */
  private autoExpand(topic: string) {
    const parts = topic.split('/')
    const expanded = { ...this.state.expanded }
    let prefix = ''
    for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i]
      if (!(prefix in expanded)) expanded[prefix] = true
    }
    this.state = { ...this.state, expanded }
  }

  private consumeSys(m: Msg) {
    const v = Number(m.payload)
    if (Number.isNaN(v)) return
    const t = m.topic
    const patch: Partial<State> = {}
    if (/messages\/received$/.test(t)) patch.sysTotal = v
    else if (/clients\/connected$/.test(t)) patch.clientsCount = v
    else if (/messages\/dropped$/.test(t)) {
      if (this.lastDropped != null && v >= this.lastDropped) {
        const d = [...this.state.drops]
        d[d.length - 1] += v - this.lastDropped
        patch.drops = d
        patch.dropped1h = (this.state.dropped1h ?? 0) + (v - this.lastDropped)
      }
      this.lastDropped = v
    }
    if (Object.keys(patch).length) this.state = { ...this.state, ...patch }
  }

  private tick() {
    const spark = this.state.spark.slice(1).concat([this.secondCount])
    const drops = this.state.drops.slice(1).concat([0])
    // sampled here rather than on arrival so live mode (5s polls) and server
    // mode (1s stat frames) produce the same shaped trace
    const cpuHist = this.state.cpuHist.slice(1).concat([this.state.metrics?.cpu ?? 0])
    this.state = {
      ...this.state,
      clock: new Date().toTimeString().slice(0, 8),
      rate: this.secondCount,
      spark,
      drops,
      cpuHist,
      alerts: alertStates(this.state.alertRules, Date.now()),
    }
    this.secondCount = 0
    this.emit()
  }

  // ---- server-mode ingestion ----

  /**
   * Seed the whole UI from one backend payload: the retention window's topic
   * index and minute buckets, plus the most recent page of messages. We never
   * pull 24h of raw messages into the browser — only aggregates plus a window.
   */
  hydrate(b: Bootstrap) {
    const topics = new Map<string, TopicStat>()
    for (const t of b.topics) {
      topics.set(t.path, {
        path: t.path,
        qos: t.qos,
        retain: t.retain,
        lastTs: t.lastTs,
        total: t.total,
        // per-topic throughput buckets are a live-only view; they fill in as
        // traffic arrives rather than being replayed from history
        buckets: Array(TOPIC_BUCKETS).fill(0),
        bucketStart: t.lastTs,
      })
    }

    const expanded = { ...this.state.expanded }
    for (const path of topics.keys()) {
      const parts = path.split('/')
      let prefix = ''
      for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
        prefix = prefix ? prefix + '/' + parts[i] : parts[i]
        if (!(prefix in expanded)) expanded[prefix] = true
      }
    }

    reseedAlerts(b.messages, this.state.alertRules)
    this.cursor = b.messages.length ? b.messages[b.messages.length - 1].id : null
    this.set({
      msgs: b.messages,
      topics,
      expanded,
      history: b.buckets,
      brokerDisplay: b.brokerDisplay,
      sel: b.messages.length ? b.messages[0].id : null,
      renderCap: RENDER_CAP,
      exhausted: b.messages.length < HISTORY_PAGE,
      alerts: alertStates(this.state.alertRules, Date.now()),
    })
    this.applyServerStats(b.stats)
  }

  /** a batch of live messages relayed by the backend; ids are already assigned */
  ingestServer(batch: Msg[]) {
    if (this.state.paused || !batch.length) return
    for (const m of batch) {
      if (m.topic.startsWith('$SYS')) this.consumeSys(m)
      observeAlerts(m, this.state.alertRules)
      this.trackTopic(m)
      this.secondCount++
    }
    // the backend sends a batch oldest-first; pending is newest-first
    this.pending = batch.slice().reverse().concat(this.pending)
    if (this.pending.length > this.msgCap) this.pending.length = this.msgCap
    this.scheduleFlush()
    if (this.state.sel == null) this.state = { ...this.state, sel: batch[batch.length - 1].id }
  }

  applyServerStats(s: ServerStats) {
    this.set({
      conn: s.brokerConn,
      // TOTAL RECEIVED reflects what is stored across the retention window,
      // not just this tab's session
      sysTotal: s.totalStored,
      clientsCount: s.clientsCount,
      // the backend blanks uptime it doesn't believe, so || null is the
      // "unknown" path rather than a falsy-string accident
      uptime: s.uptime || null,
      retentionMs: s.retentionMs,
      oldestTs: s.oldestTs,
      brokerVersion: s.version || null,
      nodeStatus: s.nodeStatus || null,
      metrics: s.metrics ?? null,
    })
  }

  /** exclusive cursor for the next "load older" page */
  oldestLoadedId(): string | null {
    return this.cursor
  }

  beginLoadOlder() {
    this.set({ loadingOlder: true })
  }

  /** replace the loaded window wholesale, e.g. after a scope re-query */
  replaceWindow(msgs: Msg[]) {
    this.pending = []
    this.cursor = msgs.length ? msgs[msgs.length - 1].id : null
    this.set({
      msgs,
      renderCap: RENDER_CAP,
      loadingOlder: false,
      exhausted: msgs.length < HISTORY_PAGE,
      sel: msgs.length ? msgs[0].id : null,
    })
  }

  appendOlder(older: Msg[]) {
    if (older.length) this.cursor = older[older.length - 1].id
    this.set({
      msgs: fairShareTrim(this.state.msgs.concat(older), HISTORY_CAP),
      loadingOlder: false,
      exhausted: older.length < HISTORY_PAGE,
    })
  }

  // ---- UI actions ----
  /**
   * Registered by the server source: scoping has to re-query, because the
   * backend holds far more history than the loaded window does.
   */
  onScopeChange: ((scope: string | null) => void) | null = null

  /**
   * Registered by the server source: replace mode reads one row per topic from
   * the backend rather than from the loaded window, so it has to be re-queried
   * whenever what counts as "matching" changes.
   */
  onLatestNeeded: (() => void) | null = null

  /** the backend's answer to the current replace-mode query */
  setLatest(latest: Msg[]) {
    this.set({ latest, latestLoading: false })
  }

  private refreshLatest() {
    if (!this.state.latestOnly || !this.onLatestNeeded) return
    this.set({ latestLoading: true })
    this.onLatestNeeded()
  }

  private applyScope(scope: string | null) {
    if (scope === this.state.scope) return
    this.set({ scope })
    this.onScopeChange?.(scope)
    this.refreshLatest()
  }

  setTab = (tab: Tab) => this.set({ tab })
  select = (sel: string) => this.set({ sel })
  setScope = (scope: string | null) => this.applyScope(scope)
  toggleScope = (path: string) => this.applyScope(this.state.scope === path ? null : path)
  setFilter = (filter: string) => this.set({ filter })
  toggleExpanded = (id: string) =>
    this.set({ expanded: { ...this.state.expanded, [id]: !this.state.expanded[id] } })

  /**
   * qos and retained are applied *before* the per-topic max, both here and in
   * the backend query — so REPLACE + RETAINED is "each topic's latest retained
   * message", not "the topics whose single latest message happens to be
   * retained". That means the snapshot has to be re-queried when either
   * changes, rather than being filtered down client-side.
   */
  toggleQos = (n: 0 | 1 | 2) => {
    this.set({ qos: { ...this.state.qos, [n]: !this.state.qos[n] } })
    this.refreshLatest()
  }
  toggleRetained = () => {
    this.set({ retainedOnly: !this.state.retainedOnly })
    this.refreshLatest()
  }
  toggleLatestOnly = () => {
    const latestOnly = !this.state.latestOnly
    // dropping the snapshot on the way out stops a stale one flashing up the
    // next time replace mode is switched on
    this.set({ latestOnly, latest: latestOnly ? this.state.latest : [], latestLoading: false })
    this.refreshLatest()
  }
  togglePause = () => this.set({ paused: !this.state.paused })
  clear = () => {
    this.pending = []
    this.cursor = null
    this.set({ msgs: [], latest: [], sel: null, renderCap: RENDER_CAP })
  }

  /** reveal another screenful of the loaded window */
  showMore = () => this.set({ renderCap: this.state.renderCap + RENDER_CAP })

  // ---- alert rules ----
  private setRules(alertRules: AlertRule[]) {
    saveRules(alertRules)
    reseedAlerts(this.state.msgs, alertRules)
    this.set({ alertRules, alerts: alertStates(alertRules, Date.now()) })
  }
  addAlertRule = () => {
    const r = newRule()
    this.setRules([...this.state.alertRules, r])
    return r.id
  }
  updateAlertRule = (id: string, patch: Partial<AlertRule>) =>
    this.setRules(this.state.alertRules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  deleteAlertRule = (id: string) => this.setRules(this.state.alertRules.filter((r) => r.id !== id))
  toggleAlertMute = (id: string) => {
    const r = this.state.alertRules.find((r) => r.id === id)
    if (r) this.updateAlertRule(id, { muted: !r.muted })
  }
}

export const store = new Store()

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function visibleMessages(s: State): Msg[] {
  const inScope = (m: Msg) => !s.scope || m.topic === s.scope || m.topic.startsWith(s.scope + '/')
  const pass = (m: Msg) => inScope(m) && s.qos[m.qos] && (!s.retainedOnly || m.retain)
  if (!s.latestOnly) return s.msgs.filter(pass)

  // Replace mode: one row per topic, the newest.
  //
  // Two sources, because neither is complete on its own: s.latest is the
  // backend's snapshot of the whole retention window (so quiet topics are
  // represented at all), and s.msgs carries live traffic that has arrived
  // since, superseding it.
  //
  // Picked by timestamp rather than by list position. Position is only the
  // latest while the list is perfectly ordered end to end, and the two sources
  // interleave — a snapshot row for one topic can sit next to a live row for
  // another that is a day newer.
  const latest = new Map<string, Msg>()
  const consider = (m: Msg) => {
    if (!pass(m)) return
    const cur = latest.get(m.topic)
    if (!cur || m.ts > cur.ts) latest.set(m.topic, m)
  }
  for (const m of s.msgs) consider(m)
  for (const m of s.latest) consider(m)

  // one row per topic, so this sorts topics, not messages — cheap
  return [...latest.values()].sort((a, b) => b.ts - a.ts)
}
