// L4 observe push-hook: a gated, bounded ring-buffer ViewProxy carrying the live provenance/contention stream (won/lost/forwarded/local).

import { $ } from '../../data/index.ts'
import { type ChangeRecord } from '../transport/message.ts'

// ProvKind: the provenance/contention tag the dashboard colours by — three ACCEPTED kinds (local=owner-authored · forwarded=owner-routed · won=inbound LWW-winner applied), the LWW loser `lost`, the dedup `dropped`, and the membership transitions `view`/`writable`. All three accepted kinds audited & KEPT — DECISIONS AB.
export type ProvKind = 'won' | 'lost' | 'forwarded' | 'local' | 'dropped' | 'view' | 'writable'

// ProvRecord: one flat provenance event — scalars only (no cloned value), so an emit is cheap and the streamed frame is tiny.
export type ProvRecord = {
  t: number
  kind: ProvKind
  origin?: string
  seq?: number
  epoch?: number
  key?: string
  members?: number
  writable?: boolean
  we?: number
  ws?: number
}

// Observe: the gated controller — the streamed proxy + refcounted attach/detach + the hot-path emit-sites (onRecord/onView/onWritable).
export type Observe = {
  proxy: ReturnType<typeof $>
  attach: () => void
  detach: () => boolean
  refCount: () => number
  onRecord: (record: ChangeRecord, kind: ProvKind, extra?: { we?: number; ws?: number }) => void
  onView: (epoch: number, members: number) => void
  onWritable: (w: boolean) => void
}

// ObserveOpts: the `observe:` options object — ring-buffer size + the verbose (dedup-drop) flag.
export type ObserveOpts = {
  buffer?: number
  verbose?: boolean
}

const DEFAULT_CAP = 256

// makeObserve(): build the controller — called ONCE, lazily, on the first __observe subscribe (so an unwatched node never allocates it).
export const makeObserve = (opts: ObserveOpts = {}): Observe => {
  const want = opts.buffer === undefined ? DEFAULT_CAP : Math.floor(opts.buffer)
  const cap = want >= 1 ? want : DEFAULT_CAP
  const proxy = $({} as Record<string, ProvRecord>)
  let count = 0
  let refs = 0

  // keyStr: the dotted contended-key path (with `at` folded in) — a small string, never the value.
  const keyStr = (r: ChangeRecord): string => {
    const k = r.key ?? []
    const base = k.length === 0 ? '' : k.join('.')
    return r.at !== undefined ? (base ? base + '.' + r.at : r.at) : base
  }

  // push: write one flat event into the next ring slot — the single mutation every emit-site funnels through (drop-oldest by overwrite).
  const push = (rec: ProvRecord) => {
    const slot = count % cap
    count++
    rec.t = count
    ;(proxy as any)[String(slot)] = rec
  }

  return {
    proxy,
    attach: () => {
      refs++
    },
    detach: () => {
      if (refs > 0) refs--
      return refs === 0
    },
    refCount: () => refs,
    onRecord: (record, kind, extra) =>
      push({ t: 0, kind, origin: record.origin, seq: record.seq, epoch: record.epoch, key: keyStr(record), ...extra }),
    onView: (epoch, members) => push({ t: 0, kind: 'view', epoch, members }),
    onWritable: (w) => push({ t: 0, kind: 'writable', writable: w }),
  }
}
