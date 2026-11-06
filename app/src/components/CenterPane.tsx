import { Fragment } from 'react'
import { store, useStore, visibleMessages } from '../store'
import { RENDER_CAP } from '../config'
import { loadOlder, mode } from '../source'
import { ago, dayKey, fmtDateTime, fmtDay, fmtTime, topicFilterMatch } from '../util'
import { Sparkline } from './Sparkline'
import { Publish } from './Publish'

function Toolbar() {
  const s = useStore()
  const shown = visibleMessages(s).length
  return (
    <div className="toolbar">
      <span className="scope-label">▸ {s.scope ?? 'ALL TOPICS'}</span>
      <span className="toolbar-pipe">│</span>
      {([0, 1, 2] as const).map((n) => (
        <button key={n} className={'chip' + (s.qos[n] ? ' on' : '')} onClick={() => store.toggleQos(n)}>
          QOS {n}
        </button>
      ))}
      <button className={'chip' + (s.retainedOnly ? ' on' : '')} onClick={() => store.toggleRetained()}>
        RETAINED
      </button>
      <button
        className={'chip' + (s.latestOnly ? ' on' : '')}
        onClick={() => store.toggleLatestOnly()}
        title="show only the latest message per topic, across the whole stored window"
      >
        REPLACE
      </button>
      <div className="toolbar-right">
        {mode === 'server' && s.retentionMs > 0 && (
          <span className="shown-count">
            {Math.round(s.retentionMs / 3_600_000)}h stored
            {s.sysTotal != null ? ' · ' + s.sysTotal.toLocaleString('en-US') : ''}
          </span>
        )}
        <span className="shown-count">{shown} shown</span>
        <button className="ghost-btn" onClick={() => store.clear()}>
          CLEAR
        </button>
        <button className={'pause-btn' + (s.paused ? ' paused' : '')} onClick={() => store.togglePause()}>
          {s.paused ? '▶ RESUME' : '❚❚ PAUSE'}
        </button>
      </div>
    </div>
  )
}

function StreamTable() {
  const s = useStore()
  const all = visibleMessages(s)
  const visible = all.slice(0, s.renderCap)
  const now = Date.now()
  // replace mode already covers the whole retention window (one row per topic,
  // straight from the backend), so there is nothing behind it to page into
  const snapshot = mode === 'server' && s.latestOnly
  // reveal more of what is already loaded; once we are within a screenful of
  // the end of the loaded window, pull the next page from the backend too
  const more = () => {
    store.showMore()
    if (!snapshot && s.renderCap + RENDER_CAP >= all.length - RENDER_CAP) void loadOlder()
  }
  const hasMore = visible.length < all.length || (mode === 'server' && !snapshot && !s.exhausted)
  return (
    <div className="table-wrap">
      <div className="table-head stream-grid">
        <span>TIME</span>
        <span>QOS</span>
        <span>R</span>
        <span>TOPIC · PAYLOAD</span>
        <span className="right-al">BYTES</span>
      </div>
      <div className="table-body">
        {visible.length === 0 && (
          <div className="empty-note">
            {s.latestLoading
              ? 'loading latest per topic…'
              : s.conn !== 'connected'
                ? 'not connected to broker'
                : mode === 'server'
                  ? 'nothing stored for this scope in the retention window'
                  : 'no messages yet — waiting for traffic…'}
          </div>
        )}
        {visible.map((m, i) => {
          // the window spans a whole retention period, so the TIME column alone
          // is ambiguous: mark every midnight the list crosses
          const crossesDay = i > 0 && dayKey(visible[i - 1].ts) !== dayKey(m.ts)
          return (
            <Fragment key={m.id}>
              {crossesDay && (
                <div className="day-sep">
                  <span className="day-sep-label">{fmtDay(m.ts, now)}</span>
                </div>
              )}
              <div
                className={
                  'table-row stream-grid stream-row' +
                  (s.sel === m.id ? ' selected' : '') +
                  (i === 0 && !s.paused ? ' newest' : '')
                }
                onClick={() => store.select(m.id)}
              >
                <span className="m-time" title={fmtDateTime(m.ts)}>
                  {fmtTime(m.ts)}
                </span>
                <span className={'qos-' + m.qos}>Q{m.qos}</span>
                <span className={m.retain ? 'retain-on' : 'retain-off'}>{m.retain ? 'R' : '·'}</span>
                <span className="m-topic-cell">
                  <span className="m-topic">{m.topic}</span>
                  <span className="m-sep"> ▸ </span>
                  <span className="m-preview">{m.payload.slice(0, 90)}</span>
                </span>
                <span className="m-bytes">{m.bytes}</span>
              </div>
            </Fragment>
          )
        })}
        {hasMore && (
          <div className="load-older" onClick={more}>
            {s.loadingOlder ? 'loading…' : '▾ LOAD OLDER'}
          </div>
        )}
      </div>
    </div>
  )
}

function TopicsTable() {
  const s = useStore()
  const q = s.filter.trim()
  const now = Date.now()
  const topics = [...s.topics.values()]
    .filter((t) => !q || topicFilterMatch(q, t.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  return (
    <div className="table-wrap">
      <div className="table-head topics-grid">
        <span>TOPIC</span>
        <span>QOS</span>
        <span>RET</span>
        <span className="right-al">MSG/MIN</span>
        <span>THROUGHPUT 5m</span>
        <span className="right-al">LAST SEEN</span>
      </div>
      <div className="table-body">
        {topics.length === 0 && <div className="empty-note">no topics observed yet</div>}
        {topics.map((t) => (
          <div
            key={t.path}
            className={'table-row topics-grid' + (s.scope === t.path ? ' scoped' : '')}
            onClick={() => {
              store.toggleScope(t.path)
              store.setTab('stream')
            }}
          >
            <span className="t-path">{t.path}</span>
            <span className={'qos-' + t.qos}>Q{t.qos}</span>
            <span className={t.retain ? 'retain-on' : 'retain-off'}>{t.retain ? 'R' : '·'}</span>
            <span className="t-rate">{t.buckets.slice(-4).reduce((a, b) => a + b, 0)}</span>
            <Sparkline data={t.buckets} w={104} h={14} stroke="#5ef2ff" opacity={0.75} />
            <span className="t-last" title={fmtDateTime(t.lastTs)}>
              {ago(t.lastTs, now)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ClientsTable() {
  const s = useStore()
  return (
    <div className="table-wrap">
      <div className="table-head clients-grid">
        <span>CLIENT ID</span>
        <span>ADDRESS</span>
        <span>SUBS</span>
        <span className="right-al">TX/RX</span>
        <span>KEEPALIVE</span>
        <span className="right-al">STATE</span>
      </div>
      <div className="table-body">
        {s.clients.length === 0 && (
          <div className="empty-note">no client data — broker HTTP API unreachable or returned nothing</div>
        )}
        {s.clients.map((c) => (
          <div key={c.id} className="table-row clients-grid" style={{ cursor: 'default' }}>
            <span className="c-id">{c.id}</span>
            <span className="c-addr">{c.addr}</span>
            <span className="c-dim">{c.subs}</span>
            <span className="c-dim right-al">{c.io}</span>
            <span className="c-keep">{c.keepalive}</span>
            <span className={'c-state state-' + c.state}>{c.state}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CenterPane() {
  const s = useStore()
  return (
    <section className="panel center">
      <Toolbar />
      {s.tab === 'stream' && <StreamTable />}
      {s.tab === 'topics' && <TopicsTable />}
      {s.tab === 'clients' && <ClientsTable />}
      {s.tab === 'publish' && <Publish />}
    </section>
  )
}
