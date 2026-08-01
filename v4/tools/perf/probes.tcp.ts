//! ── tools/perf/probes.tcp — the socket throughput probe: records/sec through the REAL shell ──────
// Plan §7's coverage list names "socket throughput (records/sec, not just RTT)" — this is it, Tier-3.
// Separate file so importing the sync registry never touches node:net.
//
// What is TIMED: capture-side encode, socket writes, framing, receive-side decode+dedup+LWW+apply,
// and event-loop scheduling — the shell tax is the object. Excluded: port allocation, formation
// (one retry on fresh ports — a second failure is a PROBE-ERROR, a distinct state that never
// masquerades as drift), warmup, validity checks, teardown. WAL off (no dir): disk batching is a
// separate concern with its own seams.
//
// The completion CLOCK is a plain onApply COUNTER (runtime.ts hands every applied record to it) —
// NEVER the streams `applied` watermark: seqs are LAMPORT stamps, monotone but not contiguous, so a
// watermark comparison against a record count terminates wrong the moment anything else bumps the
// clock (the M8 panel caught exactly this in a candidate design). And never until(): its 5ms poll
// quantizes a ~250ms rep.
//
// VALIDITY is journal physics, not end-state: a tap on the sender's journal.emit tallies
// JK.dropOldest and JK.aeShip — both MUST stay 0, because a mid-rep backpressure shed that AE later
// heals leaves every end-state check (queued empty, synced true, counter reached) green while the
// median quietly measured anti-entropy instead of the socket path (the panel's B2 defect).

import { Runtime } from '../../shell/runtime.ts'
import { JK } from '../../kernel/journal.ts'
import { REC, type Rec } from '../../kernel/env.ts'
import { bench, ports } from '#utils'
import type { ProbeResult } from './probes.ts'

const REPS_TOTAL = 6 // bench.timeAsync = 1 warmup + 5 timed
const BATCHES = 20
const PER_BATCH = 1_000
const REP_RECORDS = BATCHES * PER_BATCH

export const tcpReplicate = async (): Promise<ProbeResult & { error?: string }> => {
  const attempt = async (): Promise<ProbeResult> => {
    const [pa, pb] = [await ports.free(), await ports.free()]
    const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: 0, redialMs: 50 })
    let applied = 0
    const b = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [], heartbeatMs: 0, redialMs: 50 }, () => { applied++ })
    try {
      await a.start()
      await b.start()
      //! formation UNTIMED, bounded: 4s of 5ms polls, then throw (the caller retries once on fresh ports)
      const t0 = performance.now()
      while (a.node.admitted().length !== 1 || b.node.admitted().length !== 1) {
        if (performance.now() - t0 > 4000) throw new Error('formation timeout')
        await new Promise((r) => setTimeout(r, 5))
      }
      if (!a.node.journal.armed) throw new Error('probe invalid: sender journal disarmed — the validity tap would be blind')
      //! the validity tap: count shed/AE journal rows without read() (the 4096 ring evicts under load)
      let dropOldest = 0, aeShip = 0
      const emit = a.node.journal.emit.bind(a.node.journal)
      a.node.journal.emit = (kind, x, y, z) => {
        if (kind === JK.dropOldest) dropOldest++
        else if (kind === JK.aeShip) aeShip++
        emit(kind, x, y, z)
      }
      let mono = 0
      const rep = async () => {
        const target = applied + REP_RECORDS
        for (let batch = 0; batch < BATCHES; batch++) {
          const recs: Rec[] = Array.from({ length: PER_BATCH }, (_, i) => ({
            //! bounded key space (the in-tree idiom — k % 512) + a FRESH value every record: reps stay
            // identically distributed instead of measuring an ever-growing state map
            type: REC.update, key: [`k${i % 512}`, 'v'], value: { n: ++mono, pad: 'x'.repeat(64) },
          }))
          a.write(recs)
          await new Promise((r) => setImmediate(r)) // give pause/drain the event-loop turns they need
        }
        while (applied < target) await new Promise((r) => setImmediate(r))
      }
      const ms = await bench.timeAsync(rep)
      //! validity — all three or the number does not exist
      if (dropOldest > 0 || aeShip > 0) throw new Error(`probe invalid: backpressure shed mid-run (dropOldest ${dropOldest}, aeShip ${aeShip}) — the median would measure AE, not the socket`)
      if (applied !== REPS_TOTAL * REP_RECORDS) throw new Error(`probe invalid: applied ${applied} ≠ ${REPS_TOTAL * REP_RECORDS}`)
      if (a.node.stateHash !== b.node.stateHash) throw new Error('probe invalid: not converged')
      return { ms: +ms.toFixed(1), n: REP_RECORDS, persec: Math.round(REP_RECORDS / (ms / 1000)) }
    } finally {
      await a.destroy()
      await b.destroy()
    }
  }
  try {
    return await attempt()
  } catch {
    try {
      return await attempt() // ONE retry on fresh ports — formation flakes happen on this box
    } catch (e) {
      return { ms: 0, n: REP_RECORDS, persec: 0, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
