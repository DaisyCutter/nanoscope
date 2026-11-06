import { store, useStore } from '../store'
import { publish } from '../source'

export function Publish() {
  const s = useStore()
  return (
    <div className="publish">
      <div>
        <div className="section-label" style={{ marginBottom: 4 }}>
          TOPIC
        </div>
        <input
          className="pub-input"
          value={s.pubTopic}
          onChange={(e) => store.set({ pubTopic: e.target.value })}
          spellCheck={false}
        />
      </div>
      <div className="pub-opts">
        <div className="pub-qos">
          <span className="section-label" style={{ marginBottom: 0 }}>
            QOS
          </span>
          {([0, 1, 2] as const).map((n) => (
            <button key={n} className={'chip' + (s.pubQos === n ? ' on' : '')} onClick={() => store.set({ pubQos: n })}>
              {n}
            </button>
          ))}
        </div>
        <button
          className={'chip' + (s.pubRetain ? ' on' : '')}
          onClick={() => store.set({ pubRetain: !s.pubRetain })}
        >
          RETAIN
        </button>
        <span className="section-label" style={{ marginBottom: 0 }}>
          {new TextEncoder().encode(s.pubBody).length} BYTES
        </span>
      </div>
      <div>
        <div className="section-label" style={{ marginBottom: 4 }}>
          PAYLOAD · JSON
        </div>
        <textarea
          className="pub-textarea"
          value={s.pubBody}
          onChange={(e) => store.set({ pubBody: e.target.value })}
          spellCheck={false}
        />
      </div>
      <div className="pub-actions">
        <button className="pub-btn" onClick={() => publish(s.pubTopic, s.pubBody, s.pubQos, s.pubRetain)}>
          PUBLISH ▸
        </button>
        {s.pubStatus && <span className={'pub-status' + (s.pubStatus.ok ? '' : ' err')}>{s.pubStatus.text}</span>}
      </div>
    </div>
  )
}
