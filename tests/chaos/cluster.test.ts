// Cluster-level chaos (plan §9 `tests/chaos`, IDEAS "Testing & chaos backlog").
// The existing inline L2 tests exercise SINGLE faults via full-node destroy()
// (failover, eviction, quorum-loss, acquisition, shedding). These cover the gaps
// that needed the reusable harness + the reversible-partition seam:
//   • N-node multi-origin convergence (full-mesh broadcast under concurrent writers)
//   • a true network PARTITION → HEAL (nodes alive but unreachable; majority
//     progresses, minority goes read-only + buffers; heal reconverges both) — the
//     headline gap (every prior failure test KILLED the node; this one isolates it)
//   • the crash → recover variant of the same loss (kill + WAL restore + catch-up)
//   • membership CHURN — rapid join/leave must not wedge; the cluster re-agrees on
//     one view and converges
//   • a randomized chaos soak (seeded) — interleave writes + faults, then heal/
//     restore and assert convergence
//
// Multi-node TCP timing is real, so every assertion is `until`-polled with generous
// budgets; the suite runs serially (--test-concurrency=1, see DECISIONS F1).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { value } from '../../../data/index.ts'
import { cluster, sameState, type Node } from './harness.ts'
import { until, sleep } from '#utils'

const has = (n: Node, k: string) => k in ((n.data as any)[value] ?? {})

test('chaos: 5-node full-mesh — concurrent writers from every node converge identically', async () => {
  const c = await cluster({ n: 5, wait: 300 })
  try {
    assert.ok(await c.formed(10000), 'cluster fully formed (view + mesh)')

    // each node originates its own namespace simultaneously — exercises mixed-origin
    // framing, per-origin dedup, and owner-routed forwarding under full broadcast.
    const all = c.all()
    const keys: string[] = []
    for (let i = 0; i < 12; i++)
      all.forEach((n, j) => {
        const k = `n${j}-k${i}`
        keys.push(k)
        n.data[k] = { from: j, i }
      })

    assert.ok(await until(() => c.all().every((n) => keys.every((k) => has(n, k))), 12000), 'every node holds every key')
    assert.ok(await c.converged(12000), 'all five converge to byte-identical state')
    // and exactly the written set — no echo storm / phantom keys.
    assert.equal(Object.keys((all[0].data as any)[value]).length, keys.length, 'exactly the written keys')
  } finally {
    c.destroy()
  }
})

test('chaos: network PARTITION then HEAL — majority writes, minority buffers, both reconverge', async () => {
  // evictAfter is huge ON PURPOSE: the partition must NOT trigger an eviction →
  // re-admit view-change ballot. We want the cluster to stay in one 5-member view
  // while the minority simply can't reach a quorum — so the write-gate (V1e) makes
  // it read-only. That isolates the alive-but-unreachable property cleanly AND keeps
  // the test robust: the eviction/re-admit ballot livelocks under heavy CPU
  // contention (PREPARE/ACK timeouts fire before starved ACKs arrive). The
  // eviction + rejoin path is covered separately by V1c / V1f / the churn test.
  const c = await cluster({ n: 5, wait: 350, evictAfter: 100000 })
  try {
    assert.ok(await c.formed(10000), 'cluster formed')
    assert.ok(await c.place(['seed1', 'seed2', 'seed3'], (k) => ({ k }), 10000), 'seed placed')
    assert.ok(await c.converged(10000), 'converged before the partition')

    const live = c.all()
    const majority = live.slice(0, 3) // 3 of 5 — keeps quorum, stays writable
    const minority = live.slice(3) // 2 of 5 — loses quorum, goes read-only

    c.partition(majority, minority)

    // minority can't reach a majority of its (still 5-member) view → read-only (V1e).
    assert.ok(await until(() => minority.every((n) => n.cluster.writable === false), 12000), 'minority went read-only')
    // majority keeps quorum throughout (3·2 > 5).
    assert.ok(await until(() => majority.every((n) => n.cluster.writable === true), 12000), 'majority stayed writable')

    // a write on the majority side lands across the majority but NOT on the minority.
    majority[0].data.maj = 'from-majority'
    assert.ok(await until(() => majority.every((n) => (n.data as any)[value]?.maj === 'from-majority'), 12000), 'majority took the write')
    await sleep(300)
    assert.ok(minority.every((n) => !has(n, 'maj')), 'partition held — minority never saw the majority write')

    // a write on the minority side is BUFFERED (read-only) — not visible on the majority.
    minority[0].data.min = 'from-minority'
    await sleep(300)
    assert.ok(majority.every((n) => !has(n, 'min')), 'minority write did not cross the partition')

    // HEAL: the minority regains quorum → flushes its buffer; anti-entropy backfills
    // the majority's writes. All five reconverge (the view never changed — no ballot).
    c.heal()
    assert.ok(await until(() => c.all().every((n) => has(n, 'maj') && has(n, 'min')), 30000), 'both writes present on every node after heal')
    assert.ok(await c.converged(30000), 'all five reconverged after heal')
  } finally {
    c.destroy()
  }
})

test('chaos: crash → recover — a killed node restarts from its WAL and catches up', async () => {
  // The kill/restart variant of node loss: the process dies (not just unreachable)
  // and comes back, restoring committed state from disk + healing the gap via catch-up.
  const c = await cluster({ n: 3, wait: 350, storage: true, heartbeat: { interval: 100, misses: 2 }, evictAfter: 400 })
  try {
    assert.ok(await c.formed(10000), 'cluster formed')
    assert.ok(await c.place(['a', 'b', 'c'], (k) => ({ k }), 10000), 'initial state placed')
    assert.ok(await c.converged(10000), 'converged before the crash')

    const victim = c.all()[2]
    const victimAddr = victim.cluster.me!
    const survivors = c.all().filter((n) => n !== victim)

    c.kill(victim)
    assert.ok(await until(() => survivors.every((n) => n.cluster.members.length === 2 && !n.cluster.members.includes(victimAddr)), 10000), 'victim evicted')

    // survivors keep writing while it's gone — the restarted node never saw these live.
    survivors[0].data.d = { while: 'down' }
    survivors[1].data.e = { while: 'down' }
    assert.ok(await until(() => survivors.every((n) => has(n, 'd') && has(n, 'e')), 8000), 'survivors took writes while down')

    // restart on the same port + WAL: restores {a,b,c} from disk, rejoins, catches up {d,e}.
    const revived = await c.restart(victimAddr)
    assert.ok(await until(() => c.all().every((n) => n.cluster.members.length === 3), 12000), 'revived node rejoined the view')
    const expected = { a: { k: 'a' }, b: { k: 'b' }, c: { k: 'c' }, d: { while: 'down' }, e: { while: 'down' } }
    assert.ok(await until(() => sameState((revived.data as any)[value], expected), 12000), `revived caught up: ${JSON.stringify((revived.data as any)[value])}`)
    assert.ok(await c.converged(12000), 'whole cluster converged after recovery')
  } finally {
    c.destroy()
  }
})

test('chaos: membership CHURN — rapid join/leave re-agrees on one view and converges', async () => {
  const c = await cluster({ n: 3, wait: 350, heartbeat: { interval: 100, misses: 2 }, evictAfter: 400 })
  const joined: Node[] = []
  try {
    assert.ok(await c.formed(10000), 'base cluster formed')
    assert.ok(await c.place(['x', 'y'], (k) => ({ k }), 10000), 'base state placed')

    // churn: grow, shed, grow — interleaved with writes. Each step gives the view a
    // moment to react; the final assertion is what matters (no wedge, one agreement).
    const d = await c.add()
    joined.push(d)
    d.data.fromD = 1
    const e = await c.add()
    joined.push(e)
    e.data.fromE = 1
    await sleep(400)
    c.kill(d) // drop a fresh joiner
    c.all()[0].data.afterKill = 1
    const f = await c.add()
    joined.push(f)
    f.data.fromF = 1

    // quiesce, then assert the cluster re-agreed on ONE view of exactly the live set
    // and converged (churn must not wedge the ballot or lose committed writes).
    const liveCount = c.all().length // 3 base + (d killed) + e + f = 4
    assert.ok(await until(() => c.all().every((n) => n.cluster.members.length === liveCount), 15000), `re-agreed on a ${liveCount}-member view`)
    const mem = JSON.stringify(c.all()[0].cluster.members)
    assert.ok(c.all().every((n) => JSON.stringify(n.cluster.members) === mem), 'every node agrees on the same committed view')
    assert.ok(await until(() => c.all().every((n) => has(n, 'fromE') && has(n, 'fromF') && has(n, 'afterKill') && has(n, 'x')), 15000), 'all committed writes present')
    assert.ok(await c.converged(15000), 'converged after churn')
  } finally {
    joined.forEach((n) => {
      try {
        n.destroy()
      } catch {}
    })
    c.destroy()
  }
})

test('chaos: randomized soak — interleave writes + faults, then heal/restore and converge', async () => {
  // A seeded pseudo-random sequence of {write, partition, heal}. The invariant is
  // end-state: after a final heal, every node converges and every key committed on a
  // writable majority is present. (evictAfter is huge so the partitions stay write-gate
  // events, not eviction ballots — same robustness reason as the partition→heal test.)
  let s = 0x9e3779b9 >>> 0
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 1 | s) >>> 0)), ((s ^ (s >>> 7)) >>> 0) / 0xffffffff)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]

  const c = await cluster({ n: 5, wait: 350, evictAfter: 100000 })
  const committed = new Set<string>()
  let partitioned = false
  let writeId = 0
  try {
    assert.ok(await c.formed(12000), 'cluster formed')

    for (let step = 0; step < 16; step++) {
      const op = pick(['write', 'write', 'write', 'partition', 'heal'])
      if (op === 'write') {
        // write on a node that can currently reach a majority (its write will commit + survive).
        const writers = c.all().filter((n) => n.cluster.writable)
        if (writers.length) {
          const k = `w${writeId++}`
          pick(writers).data[k] = { step }
          committed.add(k)
        }
      } else if (op === 'partition' && !partitioned && c.all().length >= 4) {
        const live = c.all()
        const cut = Math.max(1, Math.floor(live.length / 2))
        c.partition(live.slice(0, live.length - cut), live.slice(live.length - cut))
        partitioned = true
      } else if (op === 'heal' && partitioned) {
        c.heal()
        partitioned = false
      }
      await sleep(250)
    }

    // settle: heal everything, give the cluster room to re-merge + reconcile. The
    // caps are generous — `until` returns the instant the condition holds, so the
    // headroom only matters under load, never the happy path.
    if (partitioned) c.heal()
    assert.ok(await until(() => c.all().every((n) => n.cluster.members.length === c.all().length), 45000), 'membership re-merged after the soak')

    // every majority-committed key must be present everywhere, and all nodes converge.
    // (A write only ever enters `committed` when issued on a node that could reach a
    // quorum, so it commits on the majority and survives — or buffers on an
    // alive-but-isolated node and flushes on heal; either way it must end up present.)
    const keys = [...committed]
    assert.ok(keys.length > 0, 'the soak committed at least one write')
    assert.ok(await until(() => c.all().every((n) => keys.every((k) => has(n, k))), 45000), `all ${keys.length} committed keys present on every node`)
    assert.ok(await c.converged(45000), 'converged after the randomized soak')
  } finally {
    c.destroy()
  }
})
