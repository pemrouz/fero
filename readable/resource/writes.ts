// cluster.writes: a gated, bounded ring-buffer ViewProxy of the confirm-write lifecycle — in-flight writes + per-tier latency, reactively.

import { $ } from '../../data/index.ts'

// WriteTier: the guarantee a write REQUESTED (the `confirm` value). 'accepted' is local-apply; 'committed'/'replicated' ride the network.
export type WriteTier = 'accepted' | 'committed' | 'replicated'

// WriteState: where a tracked write is in its lifecycle — in flight, reached its bar, or fell short.
export type WriteState = 'pending' | 'confirmed' | 'rejected'

// WriteRecord: one flat confirm-lifecycle event — scalars only (dotted key, never the value); `latency` is the headline (ms the guarantee took).
export type WriteRecord = {
  id: number
  tier: WriteTier
  key: string
  state: WriteState
  reachedTier?: string
  reason?: string
  seq?: number
  epoch?: number
  startedAt: number
  settledAt?: number
  latency?: number
}

// WritesOpts: the `writes:` tuning — ring-buffer size (drop-oldest); default 256.
export type WritesOpts = { buffer?: number }

// WritesLog: the lazily-built controller — the streamed proxy + the two emit-sites (onStart returns the id the caller threads to onSettle).
export type WritesLog = {
  proxy: ReturnType<typeof $>
  onStart: (tier: WriteTier, key: string) => number
  onSettle: (id: number, state: Exclude<WriteState, 'pending'>, info?: Partial<WriteRecord>) => void
}

const DEFAULT_CAP = 256

// makeWritesLog(): build the controller — called ONCE, lazily, on the first cluster.writes access (so an unwatched node never allocates the ring).
export const makeWritesLog = (opts: WritesOpts = {}): WritesLog => {
  const want = opts.buffer === undefined ? DEFAULT_CAP : Math.floor(opts.buffer)
  const cap = want >= 1 ? want : DEFAULT_CAP
  const proxy = $({} as Record<string, WriteRecord>)
  const live = new Map<number, WriteRecord>()
  const order: number[] = []
  let nextId = 0

  return {
    proxy,
    onStart: (tier, key) => {
      const id = nextId++
      const rec: WriteRecord = { id, tier, key, state: 'pending', startedAt: performance.now() }
      live.set(id, rec)
      order.push(id)
      ;(proxy as any)[String(id)] = rec
      while (order.length > cap) {
        const old = order.shift()!
        live.delete(old)
        delete (proxy as any)[String(old)]
      }
      return id
    },
    onSettle: (id, state, info) => {
      const rec = live.get(id)
      if (!rec) return
      const settledAt = performance.now()
      const next: WriteRecord = { ...rec, ...info, state, settledAt, latency: settledAt - rec.startedAt }
      live.set(id, next)
      ;(proxy as any)[String(id)] = next
    },
  }
}
