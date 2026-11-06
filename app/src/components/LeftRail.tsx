import { useState } from 'react'
import { store, useStore } from '../store'
import type { State } from '../types'
import { OPS, type AlertRule } from '../alerts'
import { SAVED_FILTERS } from '../config'
import { topicFilterMatch } from '../util'

interface Node {
  id: string
  label: string
  depth: number
  parent: string
  children: string[]
  isTopic: boolean // messages arrive on exactly this path
  count: number // recent messages in subtree (from the ring buffer)
}

function buildNodes(s: State): Map<string, Node> {
  const nodes = new Map<string, Node>()
  for (const path of s.topics.keys()) {
    const parts = path.split('/')
    let prefix = ''
    parts.forEach((p, i) => {
      const parent = prefix
      prefix = prefix ? prefix + '/' + p : p
      let n = nodes.get(prefix)
      if (!n) {
        n = { id: prefix, label: p, depth: i, parent, children: [], isTopic: false, count: 0 }
        nodes.set(prefix, n)
        const pn = nodes.get(parent)
        if (pn) pn.children.push(prefix)
      }
      if (i === parts.length - 1) n.isTopic = true
    })
  }
  for (const m of s.msgs) {
    let prefix = ''
    for (const p of m.topic.split('/')) {
      prefix = prefix ? prefix + '/' + p : p
      const n = nodes.get(prefix)
      if (n) n.count++
    }
  }
  return nodes
}

export function TopicTree() {
  const s = useStore()
  const nodes = buildNodes(s)
  const q = s.filter.trim()

  // with a filter active: match observed topics, keep ancestors visible, force-expand
  let matchSet: Set<string> | null = null
  if (q) {
    matchSet = new Set()
    for (const path of s.topics.keys()) {
      if (topicFilterMatch(q, path)) {
        let prefix = ''
        for (const p of path.split('/')) {
          prefix = prefix ? prefix + '/' + p : p
          matchSet.add(prefix)
        }
      }
    }
  }

  const rows: Node[] = []
  const walk = (parent: string) => {
    const kids = [...nodes.values()].filter((n) => n.parent === parent).sort((a, b) => a.id.localeCompare(b.id))
    for (const n of kids) {
      if (matchSet && !matchSet.has(n.id)) continue
      rows.push(n)
      const open = q ? true : !!s.expanded[n.id]
      if (open) walk(n.id)
    }
  }
  walk('')

  return (
    <div className="tree">
      {rows.length === 0 && (
        <div className="empty-note">{s.topics.size === 0 ? 'waiting for topics…' : 'no topics match'}</div>
      )}
      {rows.map((n) => {
        const branch = n.children.length > 0
        const open = q ? true : !!s.expanded[n.id]
        const active = s.scope === n.id
        return (
          <div
            key={n.id}
            className={'tree-row' + (active ? ' active' : '')}
            style={{ paddingLeft: 6 + n.depth * 11, color: branch ? '#6e849a' : '#9fb2c6' }}
            onClick={() => {
              if (branch) store.toggleExpanded(n.id)
              store.toggleScope(n.id)
            }}
          >
            <span className="tree-caret">{branch ? (open ? '▾' : '▸') : '·'}</span>
            <span
              className={'tree-dot' + (branch ? '' : ' leaf')}
              style={
                branch
                  ? undefined
                  : { background: n.count > 6 ? '#4dff9f' : n.count ? '#2f7a5a' : '#233240' }
              }
            />
            <span className="tree-label">{n.label}</span>
            <span className="tree-count">{n.count || ''}</span>
          </div>
        )
      })}
    </div>
  )
}

export function SavedFilters() {
  const s = useStore()
  return (
    <div className="rail-section">
      <div className="section-label">SAVED FILTERS</div>
      <div className="saved-list">
        {SAVED_FILTERS.map((expr) => {
          const hits = s.msgs.filter((m) => topicFilterMatch(expr, m.topic)).length
          const active = s.filter === expr
          return (
            <div
              key={expr}
              className={'saved-row' + (active ? ' active' : '')}
              onClick={() => store.setFilter(active ? '' : expr)}
            >
              <span className="saved-expr">{expr}</span>
              <span className="saved-hits">{hits}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ALERT_COLORS = { FIRING: '#ff5ec8', ARMED: '#4dff9f', MUTED: '#5c7086' }

function RuleEditor({ rule }: { rule: AlertRule }) {
  const up = (patch: Partial<AlertRule>) => store.updateAlertRule(rule.id, patch)
  return (
    <div className="rule-editor">
      <label>
        <span>name</span>
        <input value={rule.name} onChange={(e) => up({ name: e.target.value })} spellCheck={false} />
      </label>
      <label>
        <span>topic</span>
        <input
          value={rule.topic}
          onChange={(e) => up({ topic: e.target.value })}
          placeholder="airq/co2 or fleet/+/temp"
          spellCheck={false}
        />
      </label>
      {rule.op !== 'absent' && (
        <label>
          <span>field</span>
          <input
            value={rule.field}
            onChange={(e) => up({ field: e.target.value })}
            placeholder="blank = raw payload · json path e.g. env.t_c"
            spellCheck={false}
          />
        </label>
      )}
      <div className="rule-editor-row">
        <label>
          <span>op</span>
          <select value={rule.op} onChange={(e) => up({ op: e.target.value as AlertRule['op'] })}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o === 'absent' ? 'absent' : o}
              </option>
            ))}
          </select>
        </label>
        {rule.op !== 'absent' && (
          <label>
            <span>value</span>
            <input value={rule.value} onChange={(e) => up({ value: e.target.value })} spellCheck={false} />
          </label>
        )}
        <label>
          <span>{rule.op === 'absent' ? 'silence s' : 'window s'}</span>
          <input
            value={rule.windowSec}
            onChange={(e) => up({ windowSec: Math.max(1, Number(e.target.value) || 1) })}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="rule-editor-actions">
        <button className="ghost-btn danger" onClick={() => store.deleteAlertRule(rule.id)}>
          DELETE
        </button>
      </div>
    </div>
  )
}

export function AlertRules() {
  const s = useStore()
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="rail-section">
      <div className="section-label alert-head">
        <span>ALERT RULES</span>
        <button
          className="ghost-btn"
          onClick={() => setEditing(store.addAlertRule())}
          title="add a rule"
        >
          + ADD
        </button>
      </div>
      <div className="alert-list">
        {s.alerts.length === 0 && <div className="empty-note">no rules — hit + ADD</div>}
        {s.alerts.map((a) => {
          const rule = s.alertRules.find((r) => r.id === a.id)!
          return (
            <div key={a.id}>
              <div className="alert-row">
                <span
                  className="alert-dot"
                  style={{
                    background: ALERT_COLORS[a.state],
                    color: ALERT_COLORS[a.state],
                    animation: a.state === 'FIRING' ? 'blip 1s ease-in-out infinite' : undefined,
                  }}
                />
                <span
                  className="alert-name"
                  title="click to edit"
                  onClick={() => setEditing(editing === a.id ? null : a.id)}
                >
                  {a.name} · {a.detail}
                </span>
                <span
                  className="alert-badge"
                  title="click to mute / unmute"
                  style={{ color: ALERT_COLORS[a.state] }}
                  onClick={() => store.toggleAlertMute(a.id)}
                >
                  {a.state}
                </span>
              </div>
              {editing === a.id && <RuleEditor rule={rule} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LeftRail() {
  const s = useStore()
  return (
    <aside className="panel left">
      <div className="search-row">
        <span className="search-caret">▸</span>
        <input
          className="search-input"
          value={s.filter}
          onChange={(e) => store.setFilter(e.target.value)}
          placeholder="filter topics  fleet/+/temp"
          spellCheck={false}
        />
      </div>
      <TopicTree />
      <SavedFilters />
      <AlertRules />
    </aside>
  )
}
