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
import { diagnostics } from '../../resource/index.ts'
import { until, sleep } from '#utils'

const has = (n: Node, k: string) => k in ((n.data as any)[value] ?? {})
//! tally(n): writer-side in-flight confirm:'replicated' probes on a node — must drain to 0 (no leak after a partition/heal).
const tally = (n: Node) => (n as any)[diagnostics].confirms().tally as number

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
  // it read-only. That isolates the alive-but-unreachable property cleanly. The
  // eviction-DURING-partition → heal reconcile (two distinct committed views merging
  // back to one) is covered by the dedicated eviction-heal scenario below + the
  // deterministic membership.test.ts (DECISIONS Y); eviction + rejoin in isolation by
  // V1c / V1f / the churn test.
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

test('chaos: SCOPED (R=2) partition then heal — disjoint holding stays correct; both sides reconverge on their R-sets', async () => {
  // Every other chaos scenario runs full replication; this one exercises the SCOPED paths
  // (owner-routing, R-way replicateTo, anti-entropy acquisition) under a real partition+heal —
  // where the write-path hardening (ack-confirmed forward, epoch-dominance) and the membership
  // reconcile all interact with disjoint holding. evictAfter huge so it stays a write-gate event
  // (one 4-member view throughout), isolating the scoped-replication behaviour from eviction.
  const c = await cluster({ n: 4, replicas: 2, antiEntropy: 200, wait: 350, evictAfter: 100000 })
  try {
    assert.ok(await c.formed(12000), 'scoped cluster formed')
    assert.ok(await c.place(['ka', 'kb', 'kc', 'kd'], (k) => ({ k }), 12000), 'keys placed on their R-sets')
    assert.ok(await c.heldOnReplicas(['ka', 'kb', 'kc', 'kd'], 12000), 'each key on exactly its 2-replica R-set, nowhere else')

    const live = c.all()
    const majority = live.slice(0, 3) // 3 of 4 keeps quorum
    const minority = live.slice(3) // 1 of 4 → read-only
    c.partition(majority, minority)
    assert.ok(await until(() => minority.every((n) => n.cluster.writable === false), 12000), 'minority went read-only')

    // a write on the majority side to a key the majority can own/route lands on its R-set
    majority[0].data.ke = { k: 'ke' }
    assert.ok(await until(() => { const reps = majority[0].cluster.replicas('ke').filter((a) => majority.some((m) => m.cluster.me === a)); return reps.length > 0 && reps.every((a) => has(c.node(a)!, 'ke')) }, 12000), 'majority-side scoped write replicated to its reachable R-set')

    // HEAL: the minority regains quorum; anti-entropy re-syncs the scoped holding both ways
    c.heal()
    assert.ok(await c.heldOnReplicas(['ka', 'kb', 'kc', 'kd', 'ke'], 30000), 'after heal every key is back on exactly its R-set (no over- or under-replication)')
    assert.equal(c.servedSubs(), 0, 'no served-subscription leak across the scoped partition/heal')
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
    // leak guard (the harness exposes servedSubs() for exactly this): the churn opened no
    // subscriptions, so after reap every node serves ZERO — a leaked sink/openFold would show here.
    // (A peer-ROW leak assertion waits on the max=Infinity forget(address) item — a killed node is
    // redialed forever, so its pool row legitimately persists; the VIEW excludes it, asserted above.)
    assert.equal(c.servedSubs(), 0, 'no served-subscription leak across the churn')
  } finally {
    joined.forEach((n) => {
      try {
        n.destroy()
      } catch {}
    })
    c.destroy()
  }
})

test('chaos: EVICTION during a partition then HEAL — two committed views reconcile to one (DECISIONS X #1)', async () => {
  // The deadlock the full-project review found: with eviction ON, a partition makes the two
  // sides commit DISTINCT views. Put the global-LOWEST address in the evicted minority — so on
  // heal the merged coordinator is back on its STALE larger view with NO member-set delta
  // (everyone reachable, all already in its view). Pre-fix it never re-proposed → two epochs
  // forever. The view re-announce surfaces the majority's higher epoch so the coordinator
  // re-proposes a unifying view that re-admits the minority. (Eviction is timing-real, so the
  // budgets are generous; the re-announce continuously re-drives convergence, so heal is robust.)
  const c = await cluster({ n: 5, wait: 350, heartbeat: { interval: 100, misses: 2 }, evictAfter: 600 })
  try {
    assert.ok(await c.formed(12000), 'cluster formed as one 5-member view')
    assert.ok(await c.place(['seed'], (k) => ({ k }), 10000), 'seed placed')
    const baseEpoch = c.all()[0].cluster.epoch

    // minority = the TWO lowest addresses (so the global-lowest — the post-heal coordinator —
    // is on the STALE side); majority = the three highest (keeps quorum, will evict the two).
    const byAddr = c.all().slice().sort((a, b) => (a.cluster.me! < b.cluster.me! ? -1 : 1))
    const minority = byAddr.slice(0, 2)
    const majority = byAddr.slice(2)
    c.partition(majority, minority)

    // the majority evicts the minority → commits a NEW, smaller, higher-epoch view
    assert.ok(
      await until(() => majority.every((n) => n.cluster.members.length === 3 && n.cluster.epoch > baseEpoch), 20000),
      'majority evicted the minority and committed a 3-member view at a higher epoch',
    )
    // the minority is a 2-of-5 remnant → write-gated, still on the stale 5-member view
    assert.ok(minority.every((n) => n.cluster.writable === false), 'minority is read-only')
    assert.ok(minority.every((n) => n.cluster.members.length === 5), 'minority still on the stale 5-member view (the split)')

    // HEAL — the reconcile must re-admit the minority into ONE view at a fresh epoch.
    c.heal()
    assert.ok(
      await until(() => { const ms = c.all().map((n) => n.cluster.members.length); const es = c.all().map((n) => n.cluster.epoch); return ms.every((m) => m === 5) && es.every((e) => e === es[0]) }, 30000),
      'all five reconciled to ONE 5-member view at one epoch after heal (no permanent split-brain)',
    )
    assert.ok(await c.converged(20000), 'state reconverged')
  } finally {
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

// ── confirm:'replicated' under membership churn (DECISIONS Z; IDEAS Write-confirmation tiers) ──
// `replicated` probes the key's R-set for (origin,seq) and resolves at W. A partition that
// strands probe targets is the adversarial case: the write IS committed (the owner stayed
// writable), but the stronger replicated bar can't be confirmed. These two scenarios pin
// the two outcomes — reject promptly when W is genuinely unreachable, resolve when a view
// change rotates fresh holders into the R-set — and assert the writer-side tally never leaks.

test("chaos: confirm:'replicated' — probe targets stranded by a partition reject 'quorum' (no hang, no tally leak)", async () => {
  // evictAfter huge ON PURPOSE: stays one 5-member view, so the R-set never shrinks and
  // recount can't rescue it — the per-cid timer is the ONLY way out. R=3 ⇒ W=2; the owner
  // needs 1 ack from its 2 R-set peers. Strand BOTH peers (minority) while keeping the owner
  // in a 3-of-5 majority (owner + the 2 non-R-set nodes) so phase 1 still commits. The probe
  // can never reach W ⇒ the await must REJECT 'quorum' (committed-but-not-replicated), bounded
  // by the short timeout — not hang — and the in-flight tally must drain to 0.
  const c = await cluster({ n: 5, replicas: 3, antiEntropy: 200, wait: 350, evictAfter: 100000 })
  try {
    assert.ok(await c.formed(12000), 'scoped R=3 cluster formed')

    const k = 'rk'
    const rset = c.replicasOf(k) // [owner, r1, r2]
    assert.equal(rset.length, 3, 'R-set is the owner + 2 replicas')
    const owner = c.node(rset[0])!
    const peers = rset.slice(1).map((a) => c.node(a)!) // the 2 R-set peers to strand
    const others = c.all().filter((n) => !rset.includes(n.cluster.me!)) // the 2 non-R-set nodes
    assert.equal(others.length, 2, 'two nodes outside the R-set')

    // owner + the 2 outsiders = 3 of 5 → keeps quorum (writable); the 2 R-set peers = 2 of 5 → read-only.
    c.partition([owner, ...others], peers)
    assert.ok(await until(() => peers.every((n) => n.cluster.writable === false), 12000), 'the two R-set peers went read-only')
    assert.ok(owner.cluster.writable === true, 'owner kept quorum (still writable)')

    const w = owner.cluster.writes // arm the introspection surface before the write so it captures the reject

    // commit succeeds (owner is writable) but the R-set peers are unreachable → no probe ack.
    const t0 = Date.now()
    await assert.rejects(
      owner.methods.update({ key: [k], value: { v: 1 }, confirm: 'replicated', timeout: 1500 }),
      (err: any) => {
        assert.equal(err.requestedTier, 'replicated', 'requested replicated')
        assert.equal(err.reason, 'quorum', "rejected 'quorum' — committed but not replicated to W")
        assert.equal(err.reachedTier, 'committed', 'reached the committed bar (the owner sequenced + logged it)')
        assert.ok(err.localCommit && typeof err.localCommit.seq === 'number', 'localCommit carries the durable seq for a non-blind retry')
        return true
      },
    )
    assert.ok(Date.now() - t0 < 6000, 'rejected via the timer, did not hang')
    assert.ok(has(owner, k), 'the write IS committed locally on the owner (only the replicated bar was missed)')
    assert.equal(tally(owner), 0, 'no writer-side probe-tally leak after the reject')

    // cluster.writes mirrors the reject reactively: a rejected record with the reason + the durable commit seq.
    const rej = (Object.values((w as any)[value]) as any[]).find((r) => r.key === k)
    assert.ok(rej && rej.state === 'rejected', 'cluster.writes shows the write as rejected')
    assert.equal(rej.reason, 'quorum', 'cluster.writes carries the reject reason')
    assert.equal(rej.reachedTier, 'committed', 'cluster.writes shows it reached committed')
    assert.equal(typeof rej.latency, 'number', 'cluster.writes stamps the time-to-reject')

    c.heal()
    assert.ok(await c.heldOnReplicas([k], 30000), 'after heal the write is back on exactly its R-set')
    assert.equal(c.servedSubs(), 0, 'no served-subscription leak')
  } finally {
    c.destroy()
  }
})

test("chaos: confirm:'replicated' — a view change re-probes the NEW R-set (recount resolves what an evicted target alone could not)", async () => {
  // The recount path: short evictAfter so stranding the R-set peers triggers a view change.
  // The owner writes confirm:'replicated' while its 2 R-set peers are partitioned away — the
  // initial probe targets them and can never ack. The majority then evicts them and commits a
  // new view; recount re-scopes the key's R-set onto the survivors (owner + the 2 ex-outsiders),
  // probes those freshly-admitted holders, they acquire the partition via resync and ack — so
  // the confirm RESOLVES 'replicated'. Without recount it would hang on the evicted peers until
  // the (here generous) timeout and reject 'quorum'; resolving proves the re-probe fired.
  const c = await cluster({ n: 5, replicas: 3, antiEntropy: 200, wait: 350, evictAfter: 800 })
  try {
    assert.ok(await c.formed(12000), 'scoped R=3 cluster formed')

    const k = 'rk'
    const rset = c.replicasOf(k) // [owner, r1, r2]
    assert.equal(rset.length, 3, 'R-set is the owner + 2 replicas')
    const owner = c.node(rset[0])!
    const peers = rset.slice(1).map((a) => c.node(a)!) // the 2 R-set peers to strand (will be evicted)
    const others = c.all().filter((n) => !rset.includes(n.cluster.me!)) // the 2 nodes that join the R-set after eviction
    assert.equal(others.length, 2, 'two nodes outside the R-set')

    c.partition([owner, ...others], peers)
    assert.ok(await until(() => peers.every((n) => n.cluster.writable === false), 12000), 'the two original R-set peers went read-only')

    // Generous timeout: if recount never re-probed the new R-set this hangs to the timeout and
    // rejects 'quorum'; resolving (well before it) is the discriminator that recount fired.
    const r: any = await owner.methods.update({ key: [k], value: { v: 2 }, confirm: 'replicated', timeout: 15000 })
    assert.equal(r.tier, 'replicated', 'resolved replicated — the new R-set (post-eviction survivors) reached W via recount')
    assert.equal(owner.cluster.members.length, 3, 'the majority committed a 3-member view (the peers were evicted)')
    assert.equal(tally(owner), 0, 'no writer-side probe-tally leak after the resolve')

    c.heal()
    assert.ok(await until(() => c.all().every((n) => n.cluster.members.length === 5), 30000), 'all five re-merged after heal')
    assert.ok(await until(() => c.all().every((n) => has(n, k) === c.replicasOf(k).includes(n.cluster.me!)), 30000), 'the write settles onto exactly its R-set after the re-merge')
  } finally {
    c.destroy()
  }
})
