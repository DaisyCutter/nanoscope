import { useStore } from './store'
import { Header } from './components/Header'
import { StatStrip } from './components/StatStrip'
import { LeftRail } from './components/LeftRail'
import { CenterPane } from './components/CenterPane'
import { Inspector } from './components/Inspector'

export default function App() {
  const s = useStore()
  return (
    <div className="root">
      <Header />
      <StatStrip />
      <main className="main">
        <LeftRail />
        <CenterPane />
        <Inspector />
      </main>
      {s.conn !== 'connected' && (
        <div className="conn-banner">
          <b>BROKER {s.conn.toUpperCase()}</b> · {s.brokerUrl}
          {s.connError ? ' · ' + s.connError : ''} · override with ?broker=ws://host:port/mqtt
        </div>
      )}
    </div>
  )
}
