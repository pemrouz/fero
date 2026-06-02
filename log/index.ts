// L1 public surface: log() + view(), and distribute() to put a log on an L0 mesh.
//
//   log()              → an append-only Log (standalone, no network)
//   view(log)          → a $() ViewProxy that materializes the log (the day-0
//                        apply, run over every record) and stays in sync as the
//                        log appends. The read side: `view(log).tap(...)` works.
//   distribute(opts)   → { data, log, mesh }: a log + its view wired to an L0
//                        mesh. Local appends replicate to peers; inbound records
//                        append locally (→ the view projects them). v1 is
//                        FULL replication (every server materializes every
//                        record, via dialed-broadcast). DHT-partitioned routing
//                        and join-time state reconciliation are L2 / deferred.

import { $, value, view as VIEWSYM } from '../../data/index.ts'
import { transport, type Mesh, type TransportOpts } from '../transport/index.ts'
import { Log } from './partition.ts'
import type { ChangeRecord } from '../transport/message.ts'

export { Log } from './partition.ts'
export { value }

export function log(): Log {
  return new Log()
}

// Apply a change record to a root `res` — the inverse of the wire codec, the
// same terminal contract day0/replicate.ts proved. The one place records become
// state. Shared with L2.
export function applyRecord(res: any, record: ChangeRecord) {
  if (record.type === 'update') res.update(record.value, record.key)
  else if (record.type === 'insert') res.insert(record.value, record.key, record.at)
  else if (record.type === 'remove') res.remove(record.key)
}

// Project a log into a $() ViewProxy: replay what's already there, then apply
// each future append. Pure read-side projection (log → view, one direction).
export function view(log: Log): any {
  const data = $({})
  const res = (data as any)[VIEWSYM].res
  for (const p of log.partitions()) for (const record of log.since(p, 0)) applyRecord(res, record)
  log.onAppend((record) => applyRecord(res, record))
  return data
}

export type DistributeOpts = TransportOpts

// A distributed log+view on an L0 mesh. Local appends (log.append) replicate to
// peers; inbound records append to the local log (→ the view projects them). The
// `inbound` guard makes replication one-hop: a record we received is not
// re-broadcast (no echo storm).
export function distribute(opts: DistributeOpts): { data: any; log: Log; mesh: Mesh } {
  const theLog = new Log()
  const data = view(theLog)
  let inbound = false

  const mesh = transport({
    ...opts,
    onRecord: (record) => {
      inbound = true
      theLog.append(record as ChangeRecord)
      inbound = false
    },
  })

  // Local appends fan out to peers; inbound ones don't (guard breaks the loop).
  theLog.onAppend((record) => {
    if (!inbound) mesh.broadcast(record)
  })

  return { data, log: theLog, mesh }
}
