// Day 0 spike — proves fero's foundational hypothesis:
//
//   change records on the wire  ===  change records in memory
//
// `data`'s $() proxy already emits change records — { type, key, value, at? } —
// through a FunctionSink (`proxy.connect(obj, fn)`). This module pipes those
// records onto a socket on one side, and on the other side replays them
// verbatim onto another $() via its root `res`. There is NO translation layer:
// the bytes that cross the wire are the same records `data` produces internally,
// and the methods we replay them with (`res.update/insert/remove`) are exactly
// the ones the proxy's own set/delete traps call (see data/core.ts set trap).
//
// If this round-trips cleanly, the rest of fero is plumbing. If it didn't, every
// assumption in plan.md would need revisiting.
//
// Framing is newline-delimited JSON — deliberately the dumbest thing that works.
// The real wire format (length-prefixed binary, lazy-deserialise, batching) is
// L0 (transport/message.ts); it is explicitly NOT what this spike tests.

import { value, view } from '../../data/index.ts'
import type { Socket } from 'node:net'

export type Change = {
  type: 'update' | 'insert' | 'remove' | 'move'
  key?: string[]
  value?: unknown
  at?: string
  from?: number
  to?: number
}

const NEWLINE = 0x0a

// — send side —
// Stream a proxy's change records (starting with the full-snapshot `update`
// FunctionSink emits on attach) onto `socket`.
//
// Returns the host object `data` pins the sink to — RETAIN IT. The view holds
// the sink only via a WeakRef, so once the host is unreachable the sink becomes
// GC-eligible and replication stops. `data`'s `connect(obj, fn)` pins the sink
// to this object (via the same `lifetimes` map as `connect(obj, 'prop')`), so
// holding the return value is the whole retention contract — no reaching into
// view internals. The `socket.writable` guard makes delivery a no-op the moment
// the socket closes, so teardown is just "drop the host"; a deterministic
// mid-stream disconnect would be a future `data` API, not needed for the spike.
export function publish(proxy: any, socket: Socket): object {
  const send = (change: Change) => {
    if (socket.writable) socket.write(JSON.stringify(change) + '\n')
  }
  return proxy.connect({}, send)
}

// — receive side —
// Apply incoming newline-framed change records onto `proxy`, verbatim, via its
// root `res`. This is the exact inverse of FunctionSink's emission.
export function subscribe(proxy: any, socket: Socket, onChange?: (c: Change) => void) {
  const res = proxy[view].res
  let buf = Buffer.alloc(0)

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    let nl: number
    while ((nl = buf.indexOf(NEWLINE)) !== -1) {
      const line = buf.subarray(0, nl).toString('utf8')
      buf = buf.subarray(nl + 1)
      if (!line) continue
      const change: Change = JSON.parse(line)
      apply(res, change)
      onChange?.(change)
    }
  })
}

// Replay one record onto a root `res`. `res.update/insert/remove(value, path, at?)`
// dispatch on path length exactly as the proxy's set/delete traps do.
export function apply(res: any, { type, key = [], value: v, at }: Change) {
  if (type === 'update') res.update(v, key)
  else if (type === 'insert') res.insert(v, key, at)
  else if (type === 'remove') res.remove(key)
  // 'move' arises only from ordering operators (sort/az/top); raw $()
  // replication of assignments/pushes/deletes never emits it. It belongs to
  // per-client projections — deferred to L2.
}

// Convenience re-export so spike scripts don't need a second import line.
export { value, view }
