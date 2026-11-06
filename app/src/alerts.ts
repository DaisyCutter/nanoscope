import type { AlertView, Msg } from './types'

// User-configurable alert rules, persisted in localStorage.
// A rule watches a topic filter (+/# wildcards) and either compares a value —
// the raw payload, or a JSON field inside it — against a threshold, or fires
// on silence ('absent': no message on the filter for the window).

export interface AlertRule {
  id: string
  name: string
  topic: string
  /** dot path into a JSON payload; empty = the raw payload itself */
  field: string
  op: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'absent'
  value: string
  windowSec: number
  muted: boolean
}

export const OPS: AlertRule['op'][] = ['>', '<', '>=', '<=', '==', '!=', 'absent']

const STORAGE_KEY = 'nanoscope.alertRules'

const DEFAULT_RULES: AlertRule[] = [
  { id: 'r1', name: 'temp_high', topic: 'airq/temperature', field: '', op: '>', value: '28', windowSec: 300, muted: false },
  { id: 'r2', name: 'co2_high', topic: 'airq/co2', field: '', op: '>', value: '1000', windowSec: 300, muted: false },
  { id: 'r3', name: 'airq stale', topic: 'airq/#', field: '', op: 'absent', value: '', windowSec: 180, muted: false },
]

export function loadRules(): AlertRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_RULES
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return DEFAULT_RULES
    return arr.filter(
      (r): r is AlertRule =>
        r && typeof r.id === 'string' && typeof r.topic === 'string' && OPS.includes(r.op),
    )
  } catch {
    return DEFAULT_RULES
  }
}

export function saveRules(rules: AlertRule[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
}

export function newRule(): AlertRule {
  return {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: 'new rule',
    topic: '',
    field: '',
    op: '>',
    value: '0',
    windowSec: 300,
    muted: false,
  }
}

/** strict MQTT filter match — no substring fallback, unlike the search box */
function mqttMatch(filter: string, topic: string): boolean {
  if (!filter) return false
  if (!filter.includes('+') && !filter.includes('#')) return filter === topic
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}

/** pull the comparable value out of a message: raw payload, or a dot-path JSON field */
function extract(m: Msg, field: string): unknown {
  if (!field) {
    const raw = m.payload.trim()
    const n = Number(raw)
    return raw !== '' && !Number.isNaN(n) ? n : raw
  }
  try {
    let v: unknown = JSON.parse(m.payload)
    for (const part of field.split('.')) {
      if (v == null || typeof v !== 'object') return undefined
      v = (v as Record<string, unknown>)[part]
    }
    return v
  } catch {
    return undefined
  }
}

function compare(v: unknown, op: AlertRule['op'], threshold: string): boolean {
  if (v === undefined || v === null) return false
  const nv = typeof v === 'number' ? v : Number(v)
  const nt = Number(threshold)
  const numeric = !Number.isNaN(nv) && !Number.isNaN(nt) && threshold.trim() !== ''
  switch (op) {
    case '>': return numeric && nv > nt
    case '<': return numeric && nv < nt
    case '>=': return numeric && nv >= nt
    case '<=': return numeric && nv <= nt
    case '==': return numeric ? nv === nt : String(v) === threshold
    case '!=': return numeric ? nv !== nt : String(v) !== threshold
    default: return false
  }
}

/**
 * Rule state is tracked per-message at ingest time (lastSeen / lastHit timestamps),
 * so windows hold up even after messages fall out of the ring buffer or the
 * stream is cleared.
 */
interface Runtime {
  lastSeen: number
  lastHit: number
}

const runtime = new Map<string, Runtime>()

function rt(id: string): Runtime {
  let r = runtime.get(id)
  if (!r) {
    r = { lastSeen: 0, lastHit: 0 }
    runtime.set(id, r)
  }
  return r
}

/** feed one incoming message through all rules */
export function observeAlerts(m: Msg, rules: AlertRule[]) {
  for (const rule of rules) {
    if (!mqttMatch(rule.topic, m.topic)) continue
    const r = rt(rule.id)
    r.lastSeen = Math.max(r.lastSeen, m.ts)
    if (rule.op !== 'absent' && compare(extract(m, rule.field), rule.op, rule.value)) {
      r.lastHit = Math.max(r.lastHit, m.ts)
    }
  }
}

/** re-derive runtime from the buffer — call after rules change so edits show immediately */
export function reseedAlerts(msgs: Msg[], rules: AlertRule[]) {
  runtime.clear()
  for (const m of msgs) observeAlerts(m, rules)
}

export function alertStates(rules: AlertRule[], now: number): AlertView[] {
  return rules.map((rule) => {
    const detail =
      rule.op === 'absent'
        ? `no msg ${rule.windowSec}s`
        : `${rule.field || 'value'} ${rule.op} ${rule.value}`
    if (rule.muted) return { id: rule.id, name: rule.name, detail, state: 'MUTED' as const }
    const r = rt(rule.id)
    const windowMs = rule.windowSec * 1000
    let firing: boolean
    if (rule.op === 'absent') {
      // armed until traffic is seen once, then fires on silence
      firing = r.lastSeen > 0 && now - r.lastSeen > windowMs
    } else {
      firing = r.lastHit > 0 && now - r.lastHit <= windowMs
    }
    return { id: rule.id, name: rule.name, detail, state: firing ? ('FIRING' as const) : ('ARMED' as const) }
  })
}
