import { store, useStore } from '../store'
import type { Tab } from '../types'

const TABS: Tab[] = ['stream', 'topics', 'clients', 'publish']

export function Header() {
  const s = useStore()
  const dotClass = s.conn === 'connected' ? 'ok' : s.conn === 'reconnecting' || s.conn === 'connecting' ? 'warn' : 'bad'
  const secure = s.brokerUrl.startsWith('wss')
  return (
    <header className="header">
      <div className="wordmark-group">
        <span className="wordmark">NANOSCOPE</span>
        <span className="proto">{s.brokerVersion ? `NanoMQ\u00a0${s.brokerVersion}` : 'MQTT\u00a05.0'}</span>
      </div>
      <div className="broker-chip">
        <span className={'broker-dot ' + dotClass} />
        <span>{s.brokerDisplay}</span>
        <span className="chip-pipe">|</span>
        <span className="chip-proto">{secure ? 'TLS' : 'WS'}</span>
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={'tab' + (s.tab === t ? ' active' : '')} onClick={() => store.setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </nav>
      <div className="header-meta">
        <span>up {s.uptime ?? '—'}</span>
        <span className="slash">/</span>
        <span className="clock">{s.clock}</span>
      </div>
    </header>
  )
}
