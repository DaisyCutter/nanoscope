import { store, useStore } from '../store'
import { dayKey, fmtDateTime, fmtMsgId, fmtTime } from '../util'

interface Token {
  text: string
  cls: string
}

/** Tokenize pretty-printed JSON (or raw text) into per-line colored spans. */
function tokenize(payload: string): Token[][] {
  let src = payload
  try {
    src = JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    // not JSON — render the raw payload as plain lines
    return payload.split('\n').map((line) => [{ text: line || ' ', cls: 'tk-plain' }])
  }
  return src.split('\n').map((line) => {
    const m = line.match(/^(\s*)(?:"((?:[^"\\]|\\.)*)"(:\s*))?(.*)$/)!
    const tokens: Token[] = []
    if (m[1]) tokens.push({ text: m[1], cls: 'tk-punct' })
    if (m[2] !== undefined) {
      tokens.push({ text: '"' + m[2] + '"', cls: 'tk-key' })
      tokens.push({ text: m[3], cls: 'tk-punct' })
    }
    let rest = m[4] ?? ''
    let trail = ''
    const tm = rest.match(/^(.*?)([,\s]*)$/)
    if (tm) {
      rest = tm[1]
      trail = tm[2]
    }
    let cls = 'tk-plain'
    if (/^".*"$/.test(rest)) cls = 'tk-str'
    else if (/^-?\d/.test(rest)) cls = 'tk-num'
    else if (/^(true|false|null)$/.test(rest)) cls = 'tk-lit'
    else if (/^[[\]{}]+$/.test(rest)) cls = 'tk-punct'
    if (rest) tokens.push({ text: rest, cls })
    if (trail) tokens.push({ text: trail, cls: 'tk-punct' })
    if (!tokens.length) tokens.push({ text: ' ', cls: 'tk-punct' })
    return tokens
  })
}

export function Inspector() {
  const s = useStore()
  // in replace mode the selected row can come from the backend's per-topic
  // snapshot, which is not part of the loaded window
  const sel = s.msgs.find((m) => m.id === s.sel) ?? s.latest.find((m) => m.id === s.sel) ?? s.msgs[0] ?? null
  const held = sel ? s.msgs.filter((m) => m.topic === sel.topic).slice(0, 6) : []
  // a quiet topic may have nothing in the window at all; show the one row we do hold
  const history = held.length === 0 && sel ? [sel] : held

  return (
    <aside className="panel inspector">
      <div className="insp-head">
        <span className="insp-title">PAYLOAD INSPECTOR</span>
        <span className="insp-id">{sel ? fmtMsgId(sel.id) : "—"}</span>
      </div>
      <div className="insp-meta">
        <div className="insp-topic">{sel?.topic ?? 'no message selected'}</div>
        <div className="insp-kv">
          <span>received</span>
          <span className="v">{sel ? fmtDateTime(sel.ts) : '—'}</span>
          <span>qos</span>
          <span className="v">{sel?.qos ?? '—'}</span>
          <span>retain</span>
          <span className="v">{sel ? String(sel.retain) : '—'}</span>
          <span>bytes</span>
          <span className="v">{sel ? sel.bytes + ' B' : '—'}</span>
          <span>client</span>
          <span className="v">{sel?.client ?? '—'}</span>
        </div>
      </div>
      <div className="insp-body">
        {sel &&
          tokenize(sel.payload).map((tokens, i) => (
            <div key={i} className="json-line">
              {tokens.map((tk, j) => (
                <span key={j} className={tk.cls}>
                  {tk.text}
                </span>
              ))}
            </div>
          ))}
      </div>
      <div className="insp-history">
        <div className="section-label">TOPIC HISTORY · LAST 6</div>
        <div className="hist-list">
          {history.map((m) => (
            <div
              key={m.id}
              className="hist-row"
              onClick={() => store.select(m.id)}
              title={fmtDateTime(m.ts)}
            >
              <span className="hist-time">
                {fmtTime(m.ts).slice(0, 8)}
                {/* a topic's last 6 can reach back over midnight; flag the ones
                    that are not from today so the bare clock isn't misread */}
                {dayKey(m.ts) !== dayKey(Date.now()) && <span className="hist-day">*</span>}
              </span>
              <span className="hist-preview">{m.payload.slice(0, 60)}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
