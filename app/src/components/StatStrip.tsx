import { useStore } from '../store'
import { fmtCount } from '../util'
import { Sparkline } from './Sparkline'

export function StatStrip() {
  const s = useStore()
  const now = Date.now()
  let active = 0
  for (const t of s.topics.values()) if (now - t.lastTs < 5 * 60_000) active++
  const total = s.sysTotal ?? s.totalSession
  const m = s.metrics
  // the broker's own dropped counter survives a reload; the $SYS-derived
  // tally only covers this tab's session, so it is the fallback
  const dropped = m?.msgsDropped ?? s.dropped1h ?? 0
  // Both figures are the NanoMQ PROCESS, not the device: memory is the
  // broker's RSS, and cpu is its own CPU time as a share of all cores
  // combined, so 100% would mean NanoMQ saturating every core on the host.
  const cpu = m?.cpu != null ? m.cpu.toFixed(1) + '%' : '—'
  const mem = m?.memory != null ? (m.memory / 1024 / 1024).toFixed(1) + ' MB' : '—'

  return (
    <section className="stats">
      <div className="stat">
        <div className="stat-label">MSG / SEC</div>
        <div className="stat-row">
          <span className="stat-value" style={{ color: '#5ef2ff' }}>
            {s.rate}
          </span>
          <Sparkline data={s.spark} w={96} h={20} stroke="#5ef2ff" opacity={0.85} />
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">TOTAL RECEIVED</div>
        <div className="stat-value">{total.toLocaleString('en-US')}</div>
      </div>
      <div className="stat">
        <div className="stat-label">TOPICS ACTIVE</div>
        <div className="stat-value">
          {active}
          <span className="stat-suffix"> / {s.topics.size}</span>
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">CLIENTS</div>
        <div className="stat-value" style={{ color: '#b6ff5c' }}>
          {s.clientsCount ?? m?.connections ?? '—'}
          <span className="stat-suffix">{m?.peakClients != null ? ` / ${m.peakClients} peak` : ' conn'}</span>
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">MSGS IN / OUT</div>
        <div className="stat-value">
          {m?.msgsIn != null ? fmtCount(m.msgsIn) : '—'}
          <span className="stat-suffix"> / {m?.msgsOut != null ? fmtCount(m.msgsOut) : '—'}</span>
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">BROKER CPU / MEM</div>
        <div className="stat-row">
          <span className="stat-value" style={{ color: '#ffb65c' }}>
            {cpu}
            <span className="stat-suffix"> / {mem}</span>
          </span>
          <Sparkline data={s.cpuHist} w={56} h={20} stroke="#ffb65c" opacity={0.7} />
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">DROPPED</div>
        <div className="stat-row">
          <span className="stat-value" style={{ color: '#ff5ec8' }}>
            {dropped}
          </span>
          <Sparkline data={s.drops} w={96} h={20} stroke="#ff5ec8" opacity={0.7} />
        </div>
      </div>
    </section>
  )
}
