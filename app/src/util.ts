/** MQTT wildcard match: supports + and #. Falls back to substring when no wildcard. */
export function topicFilterMatch(filter: string, topic: string): boolean {
  if (!filter.includes('+') && !filter.includes('#')) {
    return topic.toLowerCase().includes(filter.toLowerCase())
  }
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * Time of day only. The stream's TIME column is deliberately narrow, so the
 * date lives on the day-separator rows the table inserts at every midnight
 * boundary (and in the hover title) rather than on every row — see dayKey.
 */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8) + '.' + pad(d.getMilliseconds(), 3)
}

/** unambiguous absolute timestamp, for the inspector and hover titles */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ts)}`
}

/**
 * Local calendar day of a timestamp, as a comparable key. The backend keeps a
 * 24h window, so a loaded list almost always straddles midnight; grouping on
 * this is what stops 19:00 yesterday from reading as newer than 16:00 today.
 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function midnight(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** label for a day-boundary separator, e.g. "WED 24 SEP · YESTERDAY" */
export function fmtDay(ts: number, now: number): string {
  const d = new Date(ts)
  const label = `${DAY_NAMES[d.getDay()]} ${pad(d.getDate())} ${MONTH_NAMES[d.getMonth()]}`
  const days = Math.round((midnight(now) - midnight(ts)) / 86_400_000)
  if (days === 0) return label + ' · TODAY'
  if (days === 1) return label + ' · YESTERDAY'
  return label
}

/** compact relative age; rolls over past an hour so a 24h window stays readable */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return s + 's ago'
  const m = Math.round(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h ago'
}

/** polyline points for a sparkline, normalized to the array max */
export function poly(arr: number[], w: number, h: number): string {
  const mx = Math.max(...arr, 1)
  const step = w / Math.max(arr.length - 1, 1)
  return arr.map((v, i) => (i * step).toFixed(1) + ',' + (h - (v / mx) * (h - 1)).toFixed(1)).join(' ')
}

export function fmtCount(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n)
}

/**
 * Message ids are opaque strings: the live source mints `m000123`, the backend
 * uses its row id. Render both the same way.
 */
export function fmtMsgId(id: string): string {
  return /^\d+$/.test(id) ? 'm' + id.padStart(6, '0') : id
}
