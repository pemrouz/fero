//! cluster.writes: a gated, bounded ring-buffer ViewProxy of the confirm-write lifecycle — in-flight writes + per-tier latency, reactively.
// resource/writes.ts — the operability surface for the `confirm` tiers (DECISIONS Z;
// IDEAS "Write-confirmation tiers"). It answers the "show how long each guarantee takes"
// ask AT RUNTIME, reactively, rather than only through the perf suite: every confirmed
// write (`confirm:'accepted'|'committed'|'replicated'`) shows up as a record that goes
// `pending` → `confirmed`/`rejected` carrying its measured `latency`, so a consumer can
//   cluster.writes.filter('state', 'pending')          // what's in flight right now
//   cluster.writes.filter('tier', 'replicated').avg('latency')   // how long the W bar costs
// without a firehose — fire-and-forget writes (the steady hot path) are NOT recorded
// (they have no guarantee to time), so this only ever sees the opt-in confirm traffic.
//
// Gating: like observe.ts this is built LAZILY (on the first `cluster.writes` access) and
// the emit-sites are a single `writesLog?.…` predicted-false branch until then — a node
// nobody introspects never allocates the ring. Unlike observe it does NOT null on detach:
// its emit-sites are already OFF the steady record path (a confirm:'committed'/'replicated'
// write is paying RTTs regardless), the buffer is BOUNDED (drop-oldest) so it can't leak,
// and staying armed lets a late `await cluster.writes` still see the running history. The
// proxy carries scalars only — the dotted key path, never the value — so an emit is cheap
// and a streamed frame is tiny.

import { $ } from '../../data/index.ts'

//! WriteTier: the guarantee a write REQUESTED (the `confirm` value). 'accepted' is local-apply; 'committed'/'replicated' ride the network.
export type WriteTier = 'accepted' | 'committed' | 'replicated'

//! WriteState: where a tracked write is in its lifecycle — in flight, reached its bar, or fell short.
export type WriteState = 'pending' | 'confirmed' | 'rejected'

//! WriteRecord: one flat confirm-lifecycle event — scalars only (dotted key, never the value); `latency` is the headline (ms the guarantee took).
export type WriteRecord = {
  id: number // monotonic write id (also the proxy key, as a string) — orders the ticker
  tier: WriteTier // the guarantee REQUESTED
  key: string // the dotted key path the write targeted — NOT the value
  state: WriteState
  reachedTier?: string // confirmed ⇒ the tier reached (== tier); rejected ⇒ how far it got ('committed' | 'committed-local' | 'none')
  reason?: string // rejected ⇒ 'withheld' | 'timeout' | 'quorum' | 'unconfirmed'
  seq?: number // the owner's Lamport seq once committed (durable detection of a later supersession)
  epoch?: number // the view epoch the write committed under
  startedAt: number // performance.now() at the call (ms) — the ring slot's birth
  settledAt?: number // performance.now() when it resolved/rejected (ms)
  latency?: number // settledAt − startedAt (ms) — "how long this guarantee took"
}

//! WritesOpts: the `writes:` tuning — ring-buffer size (drop-oldest); default 256.
export type WritesOpts = { buffer?: number }

//! WritesLog: the lazily-built controller — the streamed proxy + the two emit-sites (onStart returns the id the caller threads to onSettle).
export type WritesLog = {
  proxy: ReturnType<typeof $> // the ring-buffer ViewProxy cluster.writes returns
  onStart: (tier: WriteTier, key: string) => number // a confirm write began → insert a `pending` record; returns its id
  onSettle: (id: number, state: Exclude<WriteState, 'pending'>, info?: Partial<WriteRecord>) => void // it resolved/rejected → update the record with the outcome + measured latency
}

const DEFAULT_CAP = 256

//! makeWritesLog(): build the controller — called ONCE, lazily, on the first cluster.writes access (so an unwatched node never allocates the ring).
export const makeWritesLog = (opts: WritesOpts = {}): WritesLog => {
  // floor BEFORE validating: a fractional 0<buffer<1 floors to 0 → an unbounded ring that
  // never evicts; fall back to the default (mirrors observe.ts's guard).
  const want = opts.buffer === undefined ? DEFAULT_CAP : Math.floor(opts.buffer)
  const cap = want >= 1 ? want : DEFAULT_CAP
  const proxy = $({} as Record<string, WriteRecord>)
  const live = new Map<number, WriteRecord>() // id → record, for the settle lookup + eviction (the proxy is the reactive mirror)
  const order: number[] = [] // ids in insertion order — drop-oldest when over cap
  let nextId = 0

  return {
    proxy,
    onStart: (tier, key) => {
      const id = nextId++
      const rec: WriteRecord = { id, tier, key, state: 'pending', startedAt: performance.now() }
      live.set(id, rec)
      order.push(id)
      ;(proxy as any)[String(id)] = rec
      // drop-oldest: bound memory + the wire. The oldest is almost always already settled
      // (in-flight writes settle within their timeout); evicting a still-pending one just
      // means its later onSettle finds no record and is dropped — never a resurrection.
      while (order.length > cap) {
        const old = order.shift()!
        live.delete(old)
        delete (proxy as any)[String(old)]
      }
      return id
    },
    onSettle: (id, state, info) => {
      const rec = live.get(id)
      if (!rec) return // evicted under load (drop-oldest) — nothing to update
      const settledAt = performance.now()
      const next: WriteRecord = { ...rec, ...info, state, settledAt, latency: settledAt - rec.startedAt }
      live.set(id, next)
      ;(proxy as any)[String(id)] = next // one `update` change record — the consumer sees pending → settled with latency
    },
  }
}
