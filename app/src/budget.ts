import type { Msg } from './types'

/**
 * Per-topic fair share of the message budget.
 *
 * The browser holds a fixed number of messages (MSG_CAP live, HISTORY_CAP in
 * server mode). Evicting the globally-oldest message is the obvious policy but
 * it lets one chatty publisher own the whole buffer: a topic emitting once a
 * second fills 880 slots in fifteen minutes, and everything rarer than it —
 * exactly the traffic worth looking at — is pushed out.
 *
 * So eviction is max-min fair instead. Nothing is dropped while the buffer is
 * under budget. Once it is over, every topic is guaranteed an equal share, and
 * a topic holding less than its share donates the remainder to the topics
 * still above theirs. The buffer stays exactly as full as before; the mix in it
 * is just no longer decided by whoever publishes fastest.
 */

/**
 * How many messages of each topic to keep, given a total budget.
 *
 * Walk topics from fewest messages to most, handing each an equal split of
 * what is left. Because the pool is recomputed at every step, both the
 * donations and the rounding remainder land on the topics that can use them,
 * and the quotas always sum to exactly min(total, cap).
 *
 * `counts` must be keyed newest-topic-first, which is what building it from a
 * newest-first message list gives you. It only matters when topics outnumber
 * the budget entirely — floor(pool / topicsLeft) is then 0 for the topics
 * handled first, and reversing into oldest-first order means the share that
 * runs out is spent on stale topics rather than on the ones publishing now.
 */
export function fairShareQuotas(counts: Map<string, number>, cap: number): Map<string, number> {
  const quotas = new Map<string, number>()
  const ascending = [...counts.entries()].reverse().sort((a, b) => a[1] - b[1])

  let pool = cap
  let topicsLeft = ascending.length
  for (const [topic, held] of ascending) {
    const keep = Math.min(held, Math.floor(pool / topicsLeft))
    quotas.set(topic, keep)
    pool -= keep
    topicsLeft--
  }
  return quotas
}

/**
 * Trim a newest-first message list to `cap`, dropping each topic's oldest
 * messages beyond its fair share. Order is preserved and the returned list is
 * the same array when nothing needed dropping.
 */
export function fairShareTrim(msgs: Msg[], cap: number): Msg[] {
  if (msgs.length <= cap) return msgs

  const counts = new Map<string, number>()
  for (const m of msgs) counts.set(m.topic, (counts.get(m.topic) ?? 0) + 1)

  // one topic can't crowd anyone out, so skip straight to the cheap trim
  if (counts.size < 2) return msgs.slice(0, cap)

  const quotas = fairShareQuotas(counts, cap)
  const kept = new Map<string, number>()
  const out: Msg[] = []
  for (const m of msgs) {
    const n = kept.get(m.topic) ?? 0
    if (n >= (quotas.get(m.topic) ?? 0)) continue // topic is at its share; this is its oldest
    kept.set(m.topic, n + 1)
    out.push(m)
  }
  return out
}
