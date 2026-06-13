// L2 end-to-end: fero(name, opts) as the whole public API. A single node proves
// the three surfaces compose (data writes, default + custom methods, cluster);
// a 2-node cluster proves assignment-writes and custom-method writes replicate
// and that cluster.peers reflects membership. v1 is server / full-replication.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { value } from '../../data/index.ts'
import { fero, fileStorage, diagnostics } from './index.ts'
import { ports, until, connected, sleep } from '#utils'

// Order-insensitive structural compare. Replicas converge on VALUES, not on
// object key insertion order (a node that wrote key b then received key a holds
// {b,a}; its peer holds {a,b}) — so equality must ignore key order.
const stable = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v))
const sameState = (a: unknown, b: unknown) => stable(a) === stable(b)

test('single node: data writes, default methods, and read() compose', async () => {
  const r = await fero('solo', { port: await ports.free(), wait: 50 })

  // assignment write → readable on the same proxy
  r.data.user42 = { name: 'P', active: true }
  assert.deepEqual(r.data.user42[value], { name: 'P', active: true })

  // default methods mutate data
  r.methods.update({ key: ['user42', 'active'], value: false })
  assert.equal(r.data.user42.active[value], false)
  r.methods.insert({ value: { name: 'Q' }, at: 'user99' })
  assert.equal(r.data.user99.name[value], 'Q')
  r.methods.remove({ key: ['user99'] })
  assert.equal(r.data.user99[value], undefined)

  // read() returns the live view proxy (a subscription handle, not a copy)
  const live = r.methods.read()
  assert.equal(live, r.data)
  assert.deepEqual(live[value], { user42: { name: 'P', active: false } })

  r.destroy()
})

test('custom methods are recognized by value type; config keys are not methods', async () => {
  const calls: any[] = []
  const r = await fero('rec', {
    port: await ports.free(),
    wait: 50,
    region: 'eu-west', // config (non-function) — must NOT become a method
    login: (arg: any, context: any) => {
      calls.push(arg)
      context.data[arg.id] = { online: true }
      return { ok: true, id: arg.id }
    },
  })

  assert.equal(typeof r.methods.login, 'function')
  assert.equal((r.methods as any).region, undefined) // config didn't leak in as a method
  assert.ok(r.methods.update && r.methods.read) // defaults still present alongside custom

  const reply = r.methods.login({ id: 'u1' })
  assert.deepEqual(reply, { ok: true, id: 'u1' })
  assert.deepEqual(calls, [{ id: 'u1' }])
  assert.deepEqual(r.data.u1[value], { online: true }) // handler's context.data write landed

  r.destroy()
})

test('2-node: assignment write on A replicates to B; cluster.peers reflects membership', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('shared', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('shared', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })

  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // plain assignment on A's data surface
  A.data.user42 = { name: 'P' }
  A.data.user99 = { name: 'Q' }

  const expected = { user42: { name: 'P' }, user99: { name: 'Q' } }
  assert.ok(
    await until(() => sameState(B.data[value], expected)),
    `B.data = ${JSON.stringify(B.data[value])}`,
  )
  assert.deepEqual(A.data[value], expected) // A converges too (full replication)

  // cluster.me is each server's own listen address; peers ViewProxy is queryable
  assert.equal(A.cluster.me, a1)
  assert.equal(B.cluster.me, a2)

  A.destroy()
  B.destroy()
})

test('2-node: a custom method that writes context.data replicates to the peer', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('m', {
    host: '127.0.0.1',
    port: p1,
    ports: [p1, p2],
    wait: 200,
    setScore: (arg: any, context: any) => {
      context.data[arg.id] = { score: arg.score }
      return context.data[arg.id]
    },
  })
  const B = await fero('m', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)))

  A.methods.setScore({ id: 'p1', score: 10 })
  A.methods.setScore({ id: 'p2', score: 20 })

  const expected = { p1: { score: 10 }, p2: { score: 20 } }
  assert.ok(
    await until(() => sameState(B.data[value], expected)),
    `B.data = ${JSON.stringify(B.data[value])}`,
  )

  A.destroy()
  B.destroy()
})

test('2-node: many writes converge to exactly the written keys (no echo storm)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('noecho', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('noecho', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)))

  for (let i = 0; i < 10; i++) A.data['k' + i] = i
  assert.ok(await until(() => Object.keys(B.data[value]).length === 10))
  await sleep(50) // give any echo a chance to land

  // both sides hold exactly the 10 written keys — an echo storm or dual-connection
  // double-send would surface as divergence or extra activity; convergence holds.
  // (No-echo is proven at the record level in log/index.test.ts; the same guard
  // relocates to the proxy here.)
  assert.deepEqual(A.data[value], B.data[value])
  assert.equal(Object.keys(A.data[value]).length, 10)

  A.destroy()
  B.destroy()
})

test('2-node: concurrent same-key writes converge (last-writer-wins, deterministic)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('lww', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('lww', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // Both write the SAME key before either has seen the other's write — a genuine
  // concurrent conflict (each is that node's first write → seq 1 on both, broken
  // by origin uuid). Whichever wins, BOTH must converge to it (no permanent split).
  A.data.k = 'from-A'
  B.data.k = 'from-B'

  assert.ok(
    await until(() => A.data.k[value] !== undefined && B.data.k[value] !== undefined && A.data.k[value] === B.data.k[value]),
    `A.k=${A.data.k[value]} B.k=${B.data.k[value]}`,
  )
  const winner = A.data.k[value]
  assert.ok(winner === 'from-A' || winner === 'from-B', `winner ${winner} is one of the two writes`)

  A.destroy()
  B.destroy()
})

test('2-node: a peer that joins AFTER writes catches up (anti-entropy)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('cu', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 150 })

  // A writes while it is ALONE — these records are broadcast to nobody; without
  // catch-up a later joiner would never see them.
  A.data.a = 1
  A.data.b = 2
  A.data.c = 3

  // B joins now and must converge to A's pre-existing state via the digest exchange.
  const B = await fero('cu', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 150 })
  assert.ok(await until(() => connected(A.cluster, a2)), 'A↔B connect')

  const expected = { a: 1, b: 2, c: 3 }
  assert.ok(
    await until(() => sameState(B.data[value], expected)),
    `B caught up to ${JSON.stringify(B.data[value])}`,
  )

  // and live replication still works after catch-up
  A.data.d = 4
  assert.ok(await until(() => B.data.d[value] === 4), 'live write after catch-up')

  A.destroy()
  B.destroy()
})

test('3-node: writes from one node converge on all three (full-mesh broadcast)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const a3 = `127.0.0.1:${p3}`
  const A = await fero('route', { host: '127.0.0.1', port: p1, ports: [p1, p2, p3], wait: 250 })
  const B = await fero('route', { host: '127.0.0.1', port: p2, ports: [p1, p2, p3], wait: 250 })
  const C = await fero('route', { host: '127.0.0.1', port: p3, ports: [p1, p2, p3], wait: 250 })
  try {
    assert.ok(await until(() => connected(A.cluster, a2) && connected(A.cluster, a3)), 'full mesh')

    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    for (const k of keys) A.data[k] = k
    const expected = Object.fromEntries(keys.map((k) => [k, k]))

    // Every server materializes every record (full replication) — all three converge.
    assert.ok(await until(() => sameState(B.data[value], expected), 8000), `B converged: ${Object.keys(B.data[value]).length}/30`)
    assert.ok(await until(() => sameState(C.data[value], expected), 8000), `C converged: ${Object.keys(C.data[value]).length}/30`)
  } finally {
    A.destroy()
    B.destroy()
    C.destroy()
  }
})

// ── Milestone P0: replica-set seam (cluster.replicas + the `replicas` factor) ──
// Pure routing surface — no replication behavior changes yet (P2 scopes delivery).

test('P0: full replication (default ∞) — cluster.replicas holds every partition on every member', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A = await fero('repl-full', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('repl-full', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    // The ring is driven by the committed view (not raw connections), so wait for it.
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'view committed')
    for (const k of ['user42', 'order7', 'x', 'session-abc']) {
      const set = A.cluster.replicas(k)
      assert.equal(set.length, 2, `${k} held on all members`)
      assert.equal(new Set(set).size, 2, 'distinct')
      assert.equal(set[0], A.cluster.owner(k), 'first is the owner')
      for (const m of set) assert.ok(A.cluster.members.includes(m), `${m} is a view member`)
    }
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('P0: replicas:R holds a partition on exactly R members (owner + successors clockwise)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2 })
  const A = await fero('repl-r', cfg(p1))
  const B = await fero('repl-r', cfg(p2))
  const C = await fero('repl-r', cfg(p3))
  try {
    assert.ok(await until(() => A.cluster.members.length === 3, 8000), 'view committed (3 members)')
    // Every node agrees on the same R-set for a key (the ring is the committed view).
    for (const k of ['user42', 'order7', 'k29', 'aaa', 'zzz']) {
      const set = A.cluster.replicas(k)
      assert.equal(set.length, 2, `${k} held on exactly R=2 members`)
      assert.equal(new Set(set).size, 2, 'distinct')
      assert.equal(set[0], A.cluster.owner(k), 'first is the owner')
      for (const m of set) assert.ok(A.cluster.members.includes(m), `${m} is a view member`)
      assert.deepEqual(B.cluster.replicas(k), set, 'B agrees on the R-set')
      assert.deepEqual(C.cluster.replicas(k), set, 'C agrees on the R-set')
    }
  } finally {
    A.destroy()
    B.destroy()
    C.destroy()
  }
})

// ── Milestone P2: scoped replication (R-way holding) ──
// With finite R a partition materializes on exactly its R replicas; a non-replica
// neither stores inbound records for it nor retains an optimistic copy of a write
// it originated (it forwards to the owner and drops the local value).

test('P2: replicas:2 — each partition lands on exactly its R replicas, nowhere else', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2 })
  const A = await fero('p2-place', cfg(p1))
  const B = await fero('p2-place', cfg(p2))
  const C = await fero('p2-place', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  // Fully formed = committed 3-view AND full mesh — so a forwarded write reaches a
  // connected owner (no never-drop fallback → no transient orphan to confuse the
  // immediate non-replica assertion below).
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed (view + full mesh)')
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    for (const k of keys) A.data[k] = k // A originates every write (owner / replica / foreign all exercised)

    for (const k of keys) {
      const reps = A.cluster.replicas(k) // owner + 1 successor (R=2)
      assert.equal(reps.length, 2, `${k} has 2 replicas`)
      // the 2 replicas converge on the key…
      for (const addr of reps) assert.ok(await until(() => has(node(addr), k), 8000), `replica ${addr} has ${k}`)
      // …and the 1 non-replica never materializes it (A drops the keys it forwarded
      // but doesn't hold; B/C never receive a partition they don't replicate).
      for (const n of all) if (!reps.includes(n.cluster.me)) assert.ok(!has(n, k), `non-replica ${n.cluster.me} lacks ${k}`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('P2: replicas:2 — concurrent writes from every node converge to exactly their replicas', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2 })
  const A = await fero('p2-conv', cfg(p1))
  const B = await fero('p2-conv', cfg(p2))
  const C = await fero('p2-conv', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed (view + full mesh)')
    // each node originates its own namespace — exercises per-(origin,partition) dedup
    // + scoped replication from multiple origins concurrently.
    const keys: string[] = []
    for (let i = 0; i < 12; i++) {
      A.data['a' + i] = i
      B.data['b' + i] = i
      C.data['c' + i] = i
      keys.push('a' + i, 'b' + i, 'c' + i)
    }
    for (const k of keys) {
      const reps = A.cluster.replicas(k)
      for (const addr of reps) assert.ok(await until(() => has(node(addr), k), 8000), `replica ${addr} has ${k}`)
      for (const n of all) if (!reps.includes(n.cluster.me)) assert.ok(!has(n, k), `non-replica ${n.cluster.me} lacks ${k}`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('P2: a scoped non-holder write survives — discardOptimistic must not forward a spurious remove', async () => {
  // Regression for the scoped-non-holder LOST WRITE. The set-trap materializes the value,
  // the sink forwards the insert to the owner, then discardOptimistic drops the local
  // copy. That drop writes a `remove` to the proxy, which re-emits through the write-
  // capture sink; when data DEFERS the re-entrant write (its transact _pending drain
  // runs after the issuing call returns), an `applying` boolean guard is already cleared
  // — so the remove leaked out as a FORWARDED delete and wiped the value on the owner +
  // R-set (silent cluster-wide loss). The fix tracks the discard in a partition Set that
  // survives the drain. Here A writes ONE key it neither owns nor holds; it must land on
  // its R-set and STAY (a spurious remove would arrive just after the insert).
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2 })
  const A = await fero('p2-nonholder', cfg(p1))
  const B = await fero('p2-nonholder', cfg(p2))
  const C = await fero('p2-nonholder', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')
    // a key A neither owns nor replicates — the pure-foreign write, the broken case
    const foreign = Array.from({ length: 200 }, (_, i) => 'k' + i).find((k) => !A.cluster.replicas(k).includes(A.cluster.me))!
    A.data[foreign] = 'v'
    const reps = A.cluster.replicas(foreign)
    for (const addr of reps) assert.ok(await until(() => has(node(addr), foreign), 8000), `R-set member ${addr} receives ${foreign}`)
    await sleep(300) // a spurious discard-remove would arrive shortly AFTER the insert
    for (const addr of reps) assert.ok(has(node(addr), foreign), `R-set member ${addr} STILL holds ${foreign} (no spurious discard-remove)`)
    assert.ok(!has(A, foreign), 'the non-holder A does not retain the optimistic copy')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('P2: replicas:2 — a node that joins after writes ACQUIRES its share (durability heals to R)', async () => {
  // The acquisition path (Milestone P): when membership grows, the ring rebalances
  // partitions onto the joiner, which must back-fill their history via anti-entropy
  // — else they stay under-replicated (R→R-1, silent data loss). Fast AE interval
  // so the test converges quickly.
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('p2-acq', cfg(p1))
  const B = await fero('p2-acq', cfg(p2))
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), '2-member view')
    const keys = Array.from({ length: 40 }, (_, i) => 'k' + i)
    for (const k of keys) A.data[k] = k
    assert.ok(await until(() => keys.every((k) => has(B, k)), 8000), 'B holds all (R=2 ≥ 2 members)')

    // C joins → 3-member view; the ring now assigns many partitions an R-set containing C.
    const C = await fero('p2-acq', cfg(p3))
    const all = [A, B, C]
    const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
    try {
      assert.ok(await until(() => all.every((n) => n.cluster.members.length === 3), 8000), '3-member view')
      // Every key must be held by BOTH its R-set replicas — durability healed to R,
      // no partition left under-replicated (the blocker the review caught).
      for (const k of keys) {
        for (const addr of A.cluster.replicas(k)) {
          assert.ok(await until(() => has(node(addr), k), 10000), `replica ${addr} acquired ${k}`)
        }
      }
      // And C genuinely acquired a non-trivial share (it's a replica of some keys).
      const cKeys = keys.filter((k) => A.cluster.replicas(k).includes(C.cluster.me))
      assert.ok(cKeys.length > 0, `C is a replica of some keys (got ${cKeys.length})`)
      for (const k of cKeys) assert.ok(has(C, k), `C acquired its replica key ${k}`)
    } finally {
      C.destroy()
    }
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('P4: replicas:2 — after a join rebalances the ring, orphans are SHED (exactly R replicas)', async () => {
  // P2 heals durability (acquisition); P4 restores "exactly R replicas" by shedding
  // the extra copies a former replica holds — but only AFTER the new R-set member is
  // confirmed caught up, so the partition is never under-replicated during handoff.
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('p4-shed', cfg(p1))
  const B = await fero('p4-shed', cfg(p2))
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), '2-member view')
    const keys = Array.from({ length: 40 }, (_, i) => 'k' + i)
    for (const k of keys) A.data[k] = k
    assert.ok(await until(() => keys.every((k) => has(B, k)), 8000), 'both hold all (R=2 ≥ 2 members)')

    const C = await fero('p4-shed', cfg(p3))
    const all = [A, B, C]
    const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
    try {
      assert.ok(await until(() => all.every((n) => n.cluster.members.length === 3), 8000), '3-member view')
      // Durability: each key held by BOTH its R-set replicas.
      for (const k of keys) for (const addr of A.cluster.replicas(k)) {
        assert.ok(await until(() => has(node(addr), k), 10000), `replica ${addr} holds ${k}`)
      }
      // Exactly R: every node ends up holding ONLY the keys it replicates — the orphan
      // extra-copies (former replicas dropped from a key's R-set) are shed.
      for (const n of all) {
        assert.ok(
          await until(() => keys.filter((k) => has(n, k)).every((k) => A.cluster.replicas(k).includes(n.cluster.me)), 10000),
          `${n.cluster.me} holds only its replica keys (orphans shed)`,
        )
        // …and still holds ALL of its replica keys (shedding never dropped a held one).
        for (const k of keys.filter((k) => A.cluster.replicas(k).includes(n.cluster.me))) {
          assert.ok(has(n, k), `${n.cluster.me} still holds replica key ${k}`)
        }
      }
    } finally {
      C.destroy()
    }
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('P4: replicas:2 — a FULL R-set move (both old replicas dropped) sheds safely, no loss', async () => {
  // The case single-confirmation gets wrong: with N≥4 a partition's R-set can move
  // entirely off the old pair ({A,B}→{C,D}). Both A,B become orphans; shedding either
  // before BOTH C and D are caught up would under-replicate. Confirmed shedding waits
  // for every R-set member, so no key is ever lost and each ends up on exactly R.
  const p = [await ports.free(), await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: p, wait: 300, replicas: 2, antiEntropy: 150 })
  const A = await fero('p4-move', cfg(p[0]))
  const B = await fero('p4-move', cfg(p[1]))
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), '2-member view')
    const keys = Array.from({ length: 40 }, (_, i) => 'k' + i)
    for (const k of keys) A.data[k] = k
    assert.ok(await until(() => keys.every((k) => has(B, k)), 8000), 'both hold all')

    const C = await fero('p4-move', cfg(p[2]))
    const D = await fero('p4-move', cfg(p[3]))
    const all = [A, B, C, D]
    const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
    try {
      assert.ok(await until(() => all.every((n) => n.cluster.members.length === 4), 10000), '4-member view')
      // Some key's R-set fully moved off the old pair — the multi-confirm-critical case.
      const moved = keys.filter((k) => { const r = A.cluster.replicas(k); return !r.includes(A.cluster.me) && !r.includes(B.cluster.me) })
      assert.ok(moved.length > 0, `at least one key fully moved off {A,B} (got ${moved.length})`)
      // No loss: every key on BOTH its R-set replicas.
      for (const k of keys) for (const addr of A.cluster.replicas(k)) {
        assert.ok(await until(() => has(node(addr), k), 12000), `replica ${addr} holds ${k}`)
      }
      // Exactly R: orphans shed everywhere.
      for (const n of all) {
        assert.ok(
          await until(() => keys.filter((k) => has(n, k)).every((k) => A.cluster.replicas(k).includes(n.cluster.me)), 12000),
          `${n.cluster.me} holds only its replica keys (orphans shed)`,
        )
      }
    } finally {
      C.destroy()
      D.destroy()
    }
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('P4: a never-drop write to an orphan partition converges + sheds cleanly (shedReady re-confirmed on the high-water bump)', async () => {
  // Exercises the never-drop fallback INTO an orphan — the path the B1 review's finding lives
  // on, which the other P4 tests never hit (they have no isolation, so every write forwards).
  // When a write's owner is unreachable, commitLocal commits it LOCALLY: a fresh winner
  // appended to a partition this node does NOT replicate, RAISING its shippable high-water.
  // The fix clears `shedReady[p]` there so a confirmation earned against the OLD mark can't be
  // reused to shed before the new record is R-replicated. Here A writes a foreign key whose
  // owner it has isolated; the value still reaches the full R-set (the owner heals via the
  // reachable replica), and A sheds its orphan copy only AFTER the owner reconnects + confirms.
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150, view: { evictAfter: 100_000 } })
  const A = await fero('p4-orphan-write', cfg(p1))
  const B = await fero('p4-orphan-write', cfg(p2))
  const C = await fero('p4-orphan-write', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  const v = (n: any, k: string) => (n.data[value] as any)?.[k]?.v
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 0 } // each from its owner → lands on its R-set, no orphans
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 10000), 'every key on its R-set')

    // a key A does NOT replicate; isolate BOTH ends of its OWNER↔A link so a write can't forward there.
    const foreign = keys.find((k) => !A.cluster.replicas(k).includes(A.cluster.me))!
    const owner = A.cluster.owner(foreign)!
    ;(A as any)[diagnostics].isolate(owner)
    ;(node(owner) as any)[diagnostics].isolate(A.cluster.me)

    // Write the foreign key, RETRYING until it commits LOCALLY (the never-drop fallback) rather
    // than racing the owner socket's teardown — once A holds it, commitLocal ran and orphaned it.
    let landed = false
    for (let i = 0; i < 25 && !landed; i++) {
      A.data[foreign] = { v: 99 }
      landed = await until(() => v(A, foreign) === 99, 500)
    }
    assert.ok(landed, 'A committed the foreign write locally via the never-drop fallback (orphan)')

    // No loss: BOTH R-set replicas (the reachable one directly, the isolated owner via the
    // reachable one's anti-entropy) converge to v:99 even while the owner↔A link is cut.
    assert.ok(await until(() => A.cluster.replicas(foreign).every((a) => v(node(a), foreign) === 99), 12000), 'the full R-set converged to the never-drop write — no loss')

    // Heal: the owner reconnects + confirms to A, so A can finally shed (exactly R), no loss.
    ;(A as any)[diagnostics].heal(owner)
    ;(node(owner) as any)[diagnostics].heal(A.cluster.me)
    assert.ok(await until(() => !has(A, foreign), 12000), 'A sheds the orphan once every R-set member (incl. the healed owner) is confirmed')
    assert.ok(A.cluster.replicas(foreign).every((a) => v(node(a), foreign) === 99), 'R-set still holds v:99 after the shed (no loss)')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q1: a scoped server reads a partition it does NOT hold via owner-routed `await data.x`', async () => {
  // Hold-relative reads: a held key is local+sync; a non-held key is a remote handle
  // — `await data.x` fetches one-shot from the owner, `data.x.connect(...)` opens a
  // live remote view. Here A reads a key whose R-set excludes it.
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q1', cfg(p1))
  const B = await fero('q1', cfg(p2))
  const C = await fero('q1', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    const foreign = keys.find((k) => !A.cluster.replicas(k).includes(A.cluster.me))!
    assert.ok(foreign, 'a key A does not replicate exists')

    // write it from its owner (a holder); it lands on its R-set, NOT on A.
    node(A.cluster.owner(foreign)!).data[foreign] = { v: 42 }
    assert.ok(
      await until(() => A.cluster.replicas(foreign).every((a) => foreign in (node(a).data[value] ?? {})), 8000),
      'the R-set holds the key',
    )
    assert.ok(!(foreign in (A.data[value] ?? {})), 'A does not hold it locally')

    // await A.data[foreign] → owner-routed one-shot remote read returns the value.
    let got: any
    for (let i = 0; i < 40; i++) {
      got = await A.data[foreign]
      if (got && got.v === 42) break
      await sleep(150)
    }
    assert.equal(got?.v, 42, 'A read the foreign key via owner-routed await data.x')

    // a held key stays synchronous + local (no remote handle).
    const mine = keys.find((k) => A.cluster.replicas(k).includes(A.cluster.me))!
    node(A.cluster.owner(mine)!).data[mine] = { v: 7 }
    assert.ok(await until(() => mine in (A.data[value] ?? {}), 8000), 'A holds its own key locally')
    assert.equal((A.data[value] as any)[mine]?.v, 7, 'held key reads locally and synchronously')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q1: a read-only client reads any partition via read-forwarding through its server', async () => {
  // A client connects to ONE server, but can read EVERY partition: the server it
  // reaches forwards a read for a key it doesn't hold to that key's owner.
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q1c', cfg(p1))
  const B = await fero('q1c', cfg(p2))
  const C = await fero('q1c', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  let client: any
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: k } // each written by its owner
    assert.ok(
      await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => k in (node(a).data[value] ?? {}))), 8000),
      'every key placed on its R-set',
    )
    // client dials ONLY server A.
    client = await fero('q1c', { host: '127.0.0.1', ports: [p1], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    // read keys whose owner is NOT A → must forward A→owner.
    const foreign = keys.filter((k) => A.cluster.owner(k) !== A.cluster.me)
    assert.ok(foreign.length > 0, 'some keys are owned off A')
    for (const k of foreign.slice(0, 6)) {
      let got: any
      for (let i = 0; i < 40; i++) {
        got = await client.data[k]
        if (got && got.v === k) break
        await sleep(150)
      }
      assert.equal(got?.v, k, `client read ${k} (owner ${A.cluster.owner(k)}) via forwarding through A`)
    }
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('Q1: facade robustness — prototype-name keys read remotely; nested writes route to the owner', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q1r', cfg(p1))
  const B = await fero('q1r', cfg(p2))
  const C = await fero('q1r', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')

    // (a) a partition named like an Object.prototype method must NOT be shadowed —
    // it reads via the owner-routed remote handle, not a stale local child.
    const proto = ['valueOf', 'toString', 'hasOwnProperty'].find((k) => !A.cluster.replicas(k).includes(A.cluster.me))
    if (proto) {
      node(A.cluster.owner(proto)!).data[proto] = { v: 'proto' }
      await until(() => A.cluster.replicas(proto).every((a) => proto in (node(a).data[value] ?? {})), 8000)
      let got: any
      for (let i = 0; i < 40; i++) {
        got = await A.data[proto]
        if (got && got.v === 'proto') break
        await sleep(150)
      }
      assert.equal(got?.v, 'proto', `prototype-name key ${proto} read remotely (not shadowed)`)
    }

    // (b) a depth-1 nested write into a partition A does NOT hold routes to the owner.
    const foreign = Array.from({ length: 30 }, (_, i) => 'fk' + i).find((k) => !A.cluster.replicas(k).includes(A.cluster.me))!
    assert.ok(foreign, 'a non-held key exists')
    A.data[foreign].score = 99 // nested write through the facade on a non-holder
    const owner = node(A.cluster.owner(foreign)!)
    assert.ok(
      await until(() => (owner.data[value] as any)?.[foreign]?.score === 99, 8000),
      'nested write routed to the owner',
    )
    assert.ok(!(foreign in (A.data[value] ?? {})), 'A did not orphan the nested write locally')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('3-node: a late joiner catches up to BOTH peers’ writes via one connection', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('cu3', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 150 })
  const B = await fero('cu3', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 150 })
  let C: Awaited<ReturnType<typeof fero>> | undefined
  try {
    assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

    // A and B each write; full replication means both logs hold both writes.
    A.data.fromA = 1
    B.data.fromB = 2
    const expected = { fromA: 1, fromB: 2 }
    assert.ok(await until(() => sameState(A.data[value], expected), 8000), 'A,B converge first')

    // C joins knowing ONLY A (ports:[p1]); it must end up with B's write too —
    // A's log carries B's records (it received them), so one catch-up suffices.
    C = await fero('cu3', { host: '127.0.0.1', port: p3, ports: [p1], wait: 150 })
    assert.ok(
      await until(() => sameState(C!.data[value], expected), 8000),
      `C caught up to ${JSON.stringify(C.data[value])}`,
    )
  } finally {
    A.destroy()
    B.destroy()
    C?.destroy()
  }
})

test('persistence: state survives a restart via the storage seam (WAL)', async () => {
  const path = join(os.tmpdir(), `fero-wal-${randomUUID()}.log`)
  try {
    // first instance: write some state, then tear down
    const A1 = await fero('persist', { port: await ports.free(), wait: 30, storage: fileStorage(path) })
    A1.data.user42 = { name: 'P', active: true }
    A1.methods.update({ key: ['user42', 'active'], value: false })
    A1.data.user99 = { name: 'Q' }
    A1.methods.remove({ key: ['user99'] })
    assert.deepEqual(A1.data[value], { user42: { name: 'P', active: false } })
    A1.destroy()

    // a fresh instance over the same WAL restores the materialized state
    const A2 = await fero('persist', { port: await ports.free(), wait: 30, storage: fileStorage(path) })
    assert.deepEqual(A2.data[value], { user42: { name: 'P', active: false } })

    // and writes continue cleanly on top of the restored log
    A2.data.user1 = { name: 'R' }
    assert.deepEqual(A2.data[value], { user42: { name: 'P', active: false }, user1: { name: 'R' } })
    A2.destroy()
  } finally {
    rmSync(path, { force: true })
  }
})

test('chaos: a node crashes, its peer keeps writing, it restarts and catches up', async () => {
  const path = join(os.tmpdir(), `fero-chaos-${randomUUID()}.log`)
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  try {
    const A1 = await fero('chaos', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, storage: fileStorage(path) })
    const B = await fero('chaos', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
    assert.ok(await until(() => connected(A1.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

    A1.data.a = 1
    B.data.b = 2
    const before = { a: 1, b: 2 }
    assert.ok(await until(() => sameState(A1.data[value], before)), 'A converges')
    assert.ok(await until(() => sameState(B.data[value], before)), 'B converges')

    // CRASH A — its server closes, B's dial drops and starts reconnecting.
    A1.destroy()
    await sleep(30) // let the port free

    // B keeps writing while A is down — A never sees these live.
    B.data.c = 3
    B.data.d = 4
    assert.ok(await until(() => B.data.d[value] === 4))

    // RESTART A on the same port + WAL: it restores {a,b} from disk, B reconnects,
    // and the digest exchange ships A the writes it missed while down.
    const A2 = await fero('chaos', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, storage: fileStorage(path) })
    const after = { a: 1, b: 2, c: 3, d: 4 }
    assert.ok(
      await until(() => sameState(A2.data[value], after), 4000),
      `A recovered+caught up to ${JSON.stringify(A2.data[value])}`,
    )

    A2.destroy()
    B.destroy()
  } finally {
    rmSync(path, { force: true })
  }
})

test('client subscription: methods.read() streams live updates from the server', async () => {
  const p1 = await ports.free()
  const A = await fero('sub', { host: '127.0.0.1', port: p1, wait: 50 })
  A.data.x = 1

  const C = await fero('sub', { host: '127.0.0.1', ports: [p1], wait: 200 })
  const view = C.methods.read() // consumed reactively (not awaited) ⇒ opens a live subscription

  // initial snapshot arrives over the wire
  assert.ok(await until(() => view[value]?.x === 1), `initial snapshot: ${JSON.stringify(view[value])}`)

  // a server-side write is pushed to the subscriber live
  A.data.y = 2
  assert.ok(await until(() => view[value]?.y === 2), `live insert: ${JSON.stringify(view[value])}`)

  // and an update to an existing key
  A.data.x = 10
  assert.ok(await until(() => view[value]?.x === 10), `live update: ${JSON.stringify(view[value])}`)

  C.destroy()
  A.destroy()
})

test('client subscription: the handle is reactive — connect sees post-subscription deltas', async () => {
  const p1 = await ports.free()
  const A = await fero('sub2', { host: '127.0.0.1', port: p1, wait: 50 })
  const C = await fero('sub2', { host: '127.0.0.1', ports: [p1], wait: 200 })

  const view = C.methods.read()
  const changes = view.connect([]) // capture the live change stream on the handle

  // establish the subscription first — a sentinel write must round-trip to the
  // view (otherwise writes can race the SUBSCRIBE and fold into the snapshot).
  A.data.ready = true
  assert.ok(await until(() => view[value]?.ready === true), 'subscription established')
  const base = changes.length

  // a write AFTER establishment is pushed and captured as a fresh delta
  A.data.score = 42
  assert.ok(await until(() => view[value]?.score === 42), `live delta: ${JSON.stringify(view[value])}`)
  assert.ok(changes.length > base, `change stream grew (${base} → ${changes.length})`)

  C.destroy()
  A.destroy()
})

test('client subscription: await methods.read() is a one-shot snapshot (RPC path)', async () => {
  const p1 = await ports.free()
  const A = await fero('sub3', { host: '127.0.0.1', port: p1, wait: 50 })
  A.data.a = 1
  A.data.b = 2
  const C = await fero('sub3', { host: '127.0.0.1', ports: [p1], wait: 200 })

  // awaited ⇒ one-shot RPC, returns a plain snapshot (not a live proxy)
  const snap = await C.methods.read()
  assert.deepEqual(snap, { a: 1, b: 2 })

  C.destroy()
  A.destroy()
})

test('client RPC: a read-only client dispatches method calls to its server', async () => {
  const p1 = await ports.free()
  const seenPeers: string[] = []
  const A = await fero('rpc', {
    host: '127.0.0.1',
    port: p1,
    wait: 50,
    greet: (arg: any, context: any) => {
      seenPeers.push(context.peer) // the caller — set for remote calls
      return { hello: arg.name, from: context.cluster.me }
    },
  })
  A.data.score = 42 // server-side state

  // a read-only client: no port → all method calls are RPC'd to the server
  const C = await fero('rpc', { host: '127.0.0.1', ports: [p1], wait: 200 })
  assert.equal(C.cluster.me, undefined) // it's a client

  // custom method runs on the server, value comes back over the wire
  const reply = await C.methods.greet({ name: 'world' })
  assert.deepEqual(reply, { hello: 'world', from: `127.0.0.1:${p1}` })
  assert.equal(seenPeers.length, 1) // handler ran once, on the server
  assert.ok(typeof seenPeers[0] === 'string') // context.peer was the caller's address

  // default read() returns the server's data as a snapshot (await → value)
  const snap = await C.methods.read()
  assert.deepEqual(snap, { score: 42 })

  C.destroy()
  A.destroy()
})

test('client RPC: a client write routes to the server and replicates', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('rpcw', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('rpcw', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)), 'A↔B connect')

  const C = await fero('rpcw', { host: '127.0.0.1', ports: [p1], wait: 200 })
  // client write via the default update method → runs on A → replicates to B
  await C.methods.update({ key: ['k'], value: 99 })

  assert.ok(await until(() => A.data.k[value] === 99), 'write landed on the server A')
  assert.ok(await until(() => B.data.k[value] === 99), 'and replicated to B')

  C.destroy()
  A.destroy()
  B.destroy()
})

test('client ASSIGNMENT routes to a server (epoch ≥ 2 cluster) — not stamped epoch 1 and fenced (#3)', async () => {
  // Regression: a client has no ViewManager, so viewEpoch() ≡ 1 and the old sink committed
  // `client.data.x = v` LOCALLY at epoch 1 and broadcast it. Any formed cluster commits at
  // epoch ≥ 2, so every server-written key fenced the client's epoch-1 record (B1 skip) — the
  // write was silently lost cluster-wide AND the client kept it locally (permanent divergence).
  // The client must FORWARD the assignment to a server, which re-sequences it under its epoch.
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const A: any = await fero('cli-assign', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B: any = await fero('cli-assign', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2)), 'A↔B formed')
  // wait for the VIEW to commit (connected() is only the socket) — that's what bumps the epoch past 1
  assert.ok(await until(() => A.cluster.epoch >= 2 && B.cluster.epoch >= 2, 8000), `the cluster committed a view at epoch ≥2 (A=${A.cluster.epoch} B=${B.cluster.epoch})`)
  const C: any = await fero('cli-assign', { host: '127.0.0.1', ports: [p1], wait: 200 })
  assert.ok(await until(() => connected(C.cluster, `127.0.0.1:${p1}`), 4000), 'C connected to server A')

  C.data.q = { v: 1 } // a plain assignment on the client (the facade set trap → sink)

  // it must land on a server at the server's epoch AND replicate to the whole cluster
  assert.ok(await until(() => A.data.q?.[value]?.v === 1, 6000), 'the client assignment reached server A')
  assert.ok(await until(() => B.data.q?.[value]?.v === 1, 6000), 'and replicated to B (NOT epoch-1 fenced)')

  C.destroy()
  A.destroy()
  B.destroy()
})

test('client write leaves NO sticky optimistic copy — raw snapshot stays clean, reads route remotely (no permanent stale read)', async () => {
  // Regression for the client never-reconciled STALE READ. A client holds nothing and is
  // inbound-only, so an optimistic copy left on its raw `data` proxy after a forwarded
  // write is NEVER reconciled — it stays at the written value forever even after the
  // cluster changes the key, and contradicts `await client.data.x` (which routes
  // remotely). The fix discards the client's optimistic copy on forward: data[value]
  // stays clean, reads route remotely. (Keyed `await data.x` was already remote; only the
  // raw-snapshot/operator surface changes — stale-forever → honestly-empty.)
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A: any = await fero('cli-stale', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B: any = await fero('cli-stale', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => A.cluster.epoch >= 2 && B.cluster.epoch >= 2, 8000), 'cluster committed a view')
  const C: any = await fero('cli-stale', { host: '127.0.0.1', ports: [p1], wait: 200 })
  assert.ok(await until(() => connected(C.cluster, `127.0.0.1:${p1}`), 4000), 'client C connected to A')
  try {
    C.data.q = { v: 1 } // forwarded to a server; the optimistic copy is dropped locally
    assert.ok(await until(() => A.data.q?.[value]?.v === 1, 6000), 'client write reached the cluster')
    assert.ok(!('q' in (C.data[value] ?? {})), 'client keeps NO optimistic copy of its own write')
    A.data.q = { v: 2 } // the cluster moves the key on
    assert.ok(await until(() => B.data.q?.[value]?.v === 2, 6000), 'cluster advanced q to v2')
    assert.ok(!('q' in (C.data[value] ?? {})), 'client STILL holds no stale copy after the cluster advanced')
    let got: any // a keyed read reflects the canonical (remote) value, never a stale local one
    for (let i = 0; i < 40; i++) { got = await C.data.q; if (got?.v === 2) break; await sleep(150) }
    assert.equal(got?.v, 2, 'client await data.q returns the canonical value (remote read)')
  } finally {
    C.destroy()
    A.destroy()
    B.destroy()
  }
})

// ── confirm surface: methods.update({…, confirm}) tiered write guarantees ──
// Default is fire-and-forget (await resolves with nothing); confirm:'accepted' acks the
// local apply; confirm:'committed' resolves {tier,key,seq,epoch} once the OWNER has
// sequenced + logged the write. Fire-and-forget stays the bare `data.x = v` assignment.
// replicated/persisted are deferred (need a replica-ack layer / a real fsync).

test('confirm: default (no confirm) is fire-and-forget — the write replicates, await resolves with nothing', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A: any = await fero('cf-ff', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B: any = await fero('cf-ff', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    assert.ok(await until(() => connected(A.cluster, B.cluster.me) && connected(B.cluster, A.cluster.me), 6000), 'A↔B connected')
    const r = await A.methods.update({ key: ['k1'], value: 1 }) // no confirm ⇒ fire-and-forget
    assert.equal(r, undefined, 'no-confirm await resolves with nothing (no guarantee tracked)')
    assert.ok(await until(() => B.data.k1?.[value] === 1, 6000), 'the write still replicated')
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('confirm: accepted resolves {tier:accepted} once the value is applied locally', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cf-acc', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    const r: any = await A.methods.update({ key: ['k'], value: 42, confirm: 'accepted' })
    assert.equal(r.tier, 'accepted')
    assert.deepEqual(r.key, ['k'])
    assert.equal(A.data.k?.[value], 42, 'applied locally')
  } finally {
    A.destroy()
  }
})

test('confirm: committed resolves {tier:committed,seq,epoch} when the OWNER sequences the write', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cf-own', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    // a single node owns every key → commitLocal sequences synchronously
    const r: any = await A.methods.update({ key: ['acct'], value: { bal: 100 }, confirm: 'committed' })
    assert.equal(r.tier, 'committed')
    assert.deepEqual(r.key, ['acct'])
    assert.equal(typeof r.seq, 'number', 'carries the sequenced Lamport seq')
    assert.equal(typeof r.epoch, 'number', 'carries the view epoch')
    assert.equal(r.origin, A.cluster.uuid, 'carries origin = this owner’s provenance (full LWW coordinates for supersession detection)')
    assert.deepEqual(A.data.acct?.[value], { bal: 100 })
  } finally {
    A.destroy()
  }
})

test('confirm: committed resolves for a FORWARDED write — the owner ACKs with seq/epoch', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250 })
  const A: any = await fero('cf-fwd', cfg(p1))
  const B: any = await fero('cf-fwd', cfg(p2))
  const C: any = await fero('cf-fwd', cfg(p3))
  const all = [A, B, C]
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster formed')
    const k = Array.from({ length: 100 }, (_, i) => 'f' + i).find((k) => A.cluster.owner(k) !== A.cluster.me)! // a key A does NOT own ⇒ A forwards to the owner
    const r: any = await A.methods.update({ key: [k], value: 7, confirm: 'committed' })
    assert.equal(r.tier, 'committed', 'the owner ACKed the forwarded write as committed')
    assert.equal(typeof r.seq, 'number', 'the ACK carried the owner-sequenced seq')
    const owner = all.find((n) => n.cluster.me === A.cluster.owner(k))!
    assert.equal(r.origin, owner.cluster.uuid, 'origin on the resolve is the OWNER’s provenance (re-sequenced under it), not the forwarder’s')
    assert.notEqual(r.origin, A.cluster.uuid, 'so it is NOT A’s uuid — A only forwarded')
    assert.ok(await until(() => owner.data[k]?.[value] === 7, 6000), 'the owner holds the value')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('confirm: a client confirm:committed resolves via the RPC (the server commits, the reply carries the outcome)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A: any = await fero('cf-cli', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B: any = await fero('cf-cli', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => A.cluster.epoch >= 2 && B.cluster.epoch >= 2, 8000), 'cluster committed a view')
  const C: any = await fero('cf-cli', { host: '127.0.0.1', ports: [p1], wait: 200 })
  assert.ok(await until(() => connected(C.cluster, `127.0.0.1:${p1}`), 4000), 'client connected to A')
  try {
    const r: any = await C.methods.update({ key: ['ck'], value: 9, confirm: 'committed' })
    assert.equal(r.tier, 'committed', 'client await resolved committed via the server')
    assert.ok(await until(() => A.data.ck?.[value] === 9 || B.data.ck?.[value] === 9, 6000), 'the write landed on the cluster')
  } finally {
    C.destroy()
    A.destroy()
    B.destroy()
  }
})

test('confirm: an unknown tier rejects (the tier guard)', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cf-bad', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    await assert.rejects(async () => A.methods.update({ key: ['k'], value: 1, confirm: 'nope' }), /unknown confirm tier/)
  } finally {
    A.destroy()
  }
})

test('confirm: replicated resolves immediately on a single node (W=1, no probe needed)', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cf-rep1', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    const r: any = await A.methods.update({ key: ['k'], value: 1, confirm: 'replicated' })
    assert.equal(r.tier, 'replicated', 'single-node W=1 ⇒ replicated == committed, resolves at once')
    assert.equal(typeof r.seq, 'number')
  } finally {
    A.destroy()
  }
})

test('confirm: replicated resolves once W of the R-set hold the write (owned + forwarded keys)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250 })
  const A: any = await fero('cf-rep', cfg(p1))
  const B: any = await fero('cf-rep', cfg(p2))
  const C: any = await fero('cf-rep', cfg(p3))
  const all = [A, B, C]
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster committed a 3-member view (W = majority = 2)')
    const keys = Array.from({ length: 100 }, (_, i) => 'r' + i)
    const owned = keys.find((k) => A.cluster.owner(k) === A.cluster.me)! // A sequences locally → probes the R-set, needs 1 other ack
    const foreign = keys.find((k) => A.cluster.owner(k) !== A.cluster.me)! // A forwards → owner ACKs (origin,seq) → A probes
    const ro: any = await A.methods.update({ key: [owned], value: 1, confirm: 'replicated' })
    assert.equal(ro.tier, 'replicated', 'owner-write replicated to W (a probed replica acked once caught up)')
    const rf: any = await A.methods.update({ key: [foreign], value: 2, confirm: 'replicated' })
    assert.equal(rf.tier, 'replicated', 'forwarded-write replicated to W (owner + this holder)')
    assert.ok(await until(() => all.every((n) => n.data[owned]?.[value] === 1 && n.data[foreign]?.[value] === 2), 6000), 'both writes converged on the whole R-set')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

// ── confirm:'persisted' — W of the R-set has DURABLY appended (storage.append resolved). DECISIONS Z. ──

const persistWal = () => join(os.tmpdir(), `cf-persist-${randomUUID().slice(0, 8)}.log`)

test('confirm: persisted requires a storage seam — rejects clearly without one', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cf-pers-nostore', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    let err: any
    try {
      await A.methods.update({ key: ['k'], value: 1, confirm: 'persisted' })
    } catch (e) {
      err = e
    }
    assert.ok(err && /requires a storage seam/.test(err.message), 'persisted without storage fails fast + clearly (not a silent timeout)')
  } finally {
    A.destroy()
  }
})

test('confirm: persisted resolves on a single node once its append is durable (sync seam, W=1)', async () => {
  const wal = persistWal()
  const p1 = await ports.free()
  const A: any = await fero('cf-pers1', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100, storage: fileStorage(wal) })
  try {
    const r: any = await A.methods.update({ key: ['k'], value: 1, confirm: 'persisted' })
    assert.equal(r.tier, 'persisted', 'single node W=1 + sync seam ⇒ persisted resolves')
    assert.equal(typeof r.seq, 'number')
    assert.equal(r.origin, A.cluster.uuid, 'full LWW coordinates, same as the other tiers')
  } finally {
    A.destroy()
    rmSync(wal, { force: true })
  }
})

test('confirm: persisted waits for the storage append to RESOLVE (async seam gates the resolution)', async () => {
  const p1 = await ports.free()
  let appended = 0
  const seam = { load: () => [], append: () => ((appended++), new Promise<void>((res) => setTimeout(res, 150))) } // durable only after 150ms
  const A: any = await fero('cf-pers-async', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100, storage: seam })
  try {
    const t0 = Date.now()
    const r: any = await A.methods.update({ key: ['k'], value: 1, confirm: 'persisted' })
    assert.equal(r.tier, 'persisted')
    assert.ok(Date.now() - t0 >= 140, 'resolved ONLY after the async append settled — the durable high-water gated it, not the in-memory commit')
    assert.equal(appended, 1, 'the record was appended exactly once')
  } finally {
    A.destroy()
  }
})

test('confirm: persisted resolves once W of the R-set have DURABLY appended (owned + forwarded)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const wals = [persistWal(), persistWal(), persistWal()]
  const cfg = (port: number, i: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, storage: fileStorage(wals[i]) })
  const A: any = await fero('cf-pers-multi', cfg(p1, 0))
  const B: any = await fero('cf-pers-multi', cfg(p2, 1))
  const C: any = await fero('cf-pers-multi', cfg(p3, 2))
  const all = [A, B, C]
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster formed (W = majority = 2)')
    const keys = Array.from({ length: 100 }, (_, i) => 'p' + i)
    const owned = keys.find((k) => A.cluster.owner(k) === A.cluster.me)! // A sequences + durably appends locally, durable-probes the rest
    const foreign = keys.find((k) => A.cluster.owner(k) !== A.cluster.me)! // A forwards; the owner persists, A also holds + persists
    const ro: any = await A.methods.update({ key: [owned], value: 1, confirm: 'persisted' })
    assert.equal(ro.tier, 'persisted', 'owned write durably persisted on a W-quorum of the R-set')
    const rf: any = await A.methods.update({ key: [foreign], value: 2, confirm: 'persisted' })
    assert.equal(rf.tier, 'persisted', 'forwarded write durably persisted on a W-quorum')
  } finally {
    all.forEach((n) => n.destroy())
    wals.forEach((w) => rmSync(w, { force: true }))
  }
})

test('confirm: persisted rejects quorum when a replica never durably appends (held but not durable)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const wal = persistWal()
  const stuck = { load: () => [], append: () => new Promise<void>(() => {}) } // applies in memory, NEVER becomes durable
  const A: any = await fero('cf-pers-stuck', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 250, storage: fileStorage(wal) })
  const B: any = await fero('cf-pers-stuck', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 250, storage: stuck })
  const all = [A, B]
  const formed = (n: any) => n.cluster.members.length === 2 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  try {
    assert.ok(await until(() => all.every(formed), 8000), '2-node cluster formed (W = 2)')
    const owned = Array.from({ length: 100 }, (_, i) => 's' + i).find((k) => A.cluster.owner(k) === A.cluster.me)!
    let err: any
    try {
      await A.methods.update({ key: [owned], value: 1, confirm: 'persisted', timeout: 1500 })
    } catch (e) {
      err = e
    }
    assert.ok(err, 'rejected (not resolved)')
    assert.equal(err.reason, 'quorum', "B holds it in memory but its append never resolves → not persisted to W")
    assert.equal(err.requestedTier, 'persisted')
    assert.ok(await until(() => B.data[owned]?.[value] === 1, 4000), 'the write IS present on B in memory (replicated succeeded; only DURABILITY fell short)')
  } finally {
    all.forEach((n) => n.destroy())
    rmSync(wal, { force: true })
  }
})

// ── cluster.writes: the confirm-write introspection surface (DECISIONS Z; resource/writes.ts) ──

test('cluster.writes: gated — a confirm write BEFORE first access is not recorded; after access it is', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cw-gate', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    await A.methods.update({ key: ['x'], value: 1, confirm: 'committed' }) // unwatched → writesLog gate is null, nothing recorded
    const w = A.cluster.writes // first access builds + arms the ring
    assert.equal(Object.keys((w as any)[value]).length, 0, 'the pre-access confirm write was not recorded (zero-cost until introspected)')
    await A.methods.update({ key: ['y'], value: 2, confirm: 'committed' }) // now armed → recorded
    assert.ok(
      await until(() => Object.values((w as any)[value]).some((r: any) => r.key === 'y' && r.state === 'confirmed'), 3000),
      'a post-access confirm write is recorded and reaches confirmed',
    )
  } finally {
    A.destroy()
  }
})

test('cluster.writes: each confirm tier surfaces a confirmed record carrying its measured latency (the operability ask)', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cw-life', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    const w = A.cluster.writes // arm before writing
    await A.methods.update({ key: ['a'], value: 1, confirm: 'accepted' })
    await A.methods.update({ key: ['b'], value: 2, confirm: 'committed' })
    await A.methods.update({ key: ['c'], value: 3, confirm: 'replicated' }) // single node ⇒ W=1, resolves at the committed point
    const rows = () => Object.values((w as any)[value]) as any[]
    assert.ok(await until(() => rows().length === 3 && rows().every((r) => r.state === 'confirmed'), 3000), 'all three tiers recorded + confirmed')
    const byTier = Object.fromEntries(rows().map((r) => [r.tier, r]))
    assert.equal(byTier.accepted.reachedTier, 'accepted', 'accepted = local apply')
    assert.equal(byTier.committed.reachedTier, 'committed', 'committed = owner sequenced')
    assert.equal(byTier.replicated.reachedTier, 'replicated', 'replicated = W of the R-set')
    for (const t of ['accepted', 'committed', 'replicated']) assert.equal(typeof byTier[t].latency, 'number', `${t} carries a numeric latency (how long the guarantee took)`)
    assert.equal(typeof byTier.committed.seq, 'number', 'committed/replicated carry the owner seq')
    assert.equal(byTier.committed.origin, A.cluster.uuid, 'and the owner origin (full LWW coordinates, parity with the resolve)')
    // the surface is a real ViewProxy — per-tier latency folds reactively (the "how long each guarantee takes" query)
    const avg = A.cluster.writes.filter('tier', 'replicated').avg('latency')
    assert.equal(typeof (avg as any)[value], 'number', 'avg latency over a tier is a reactive scalar')
  } finally {
    A.destroy()
  }
})

test('cluster.writes: a write is observable in flight — pending → confirmed via the change stream', async () => {
  const p1 = await ports.free()
  const A: any = await fero('cw-flight', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    const seen: string[] = []
    A.cluster.writes.tap((c: any) => {
      if (c.value && c.value.key === 'k') seen.push(c.value.state)
    })
    await A.methods.update({ key: ['k'], value: 1, confirm: 'committed' })
    assert.ok(await until(() => seen.includes('pending') && seen.includes('confirmed'), 3000), `observed the in-flight lifecycle (states: ${seen.join('→')})`)
  } finally {
    A.destroy()
  }
})

test('client write made OFFLINE buffers (bounded) and flushes when a server becomes reachable (#3)', async () => {
  // No server reachable yet: the forward fails, so the write buffers (bounded drop-oldest)
  // instead of committing at epoch 1. When a server appears, onConnect + the periodic sweep
  // drain the buffer through the forward path.
  const p1 = await ports.free()
  const C: any = await fero('cli-offline', { host: '127.0.0.1', ports: [p1], wait: 100, antiEntropy: 150 })
  C.data.early = { v: 1 } // written while NO server exists → buffered, not lost, not committed local-epoch-1
  await sleep(60)
  // now bring the server up on the port the client keeps redialing
  const A: any = await fero('cli-offline', { host: '127.0.0.1', port: p1, ports: [p1], wait: 100 })
  try {
    assert.ok(await until(() => A.data.early?.[value]?.v === 1, 8000), 'the buffered offline write flushed to the server once reachable')
  } finally {
    C.destroy()
    A.destroy()
  }
})

test('client RPC: an unknown method rejects', async () => {
  const p1 = await ports.free()
  const A = await fero('rpcerr', { host: '127.0.0.1', port: p1, wait: 50 })
  const C = await fero('rpcerr', { host: '127.0.0.1', ports: [p1], wait: 200 })

  // (the client handle is a thenable Proxy, not a Promise instance, so await it
  // and catch directly rather than via assert.rejects)
  let err: Error | undefined
  try {
    await C.methods.nope({})
  } catch (e) {
    err = e as Error
  }
  assert.match(err?.message ?? '', /unknown method/)

  C.destroy()
  A.destroy()
})

test('2-node: a write that causally follows a remote write wins (Lamport order)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('lamport', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('lamport', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

  // A writes first; B waits to SEE it, then overwrites. B's write causally
  // follows A's, so B's Lamport seq is higher → B wins on BOTH nodes, regardless
  // of which uuid sorts higher. (Without the Lamport merge, B's per-node counter
  // could be ≤ A's and B would lose to its own predecessor → permanent divergence.)
  A.data.k = 'first'
  assert.ok(await until(() => B.data.k[value] === 'first'), 'B sees A’s write')
  B.data.k = 'second'

  assert.ok(
    await until(() => A.data.k[value] === 'second' && B.data.k[value] === 'second'),
    `A.k=${A.data.k[value]} B.k=${B.data.k[value]}`,
  )

  A.destroy()
  B.destroy()
})

// ── Milestone F1: owner-routed writes (owner-authoritative, full replication) ──

test('F1: a write to a peer-owned partition is committed by the owner and replicates', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const a2 = `127.0.0.1:${p2}`
  const a3 = `127.0.0.1:${p3}`
  const A = await fero('f1own', { host: '127.0.0.1', port: p1, ports: [p1, p2, p3], wait: 250 })
  const B = await fero('f1own', { host: '127.0.0.1', port: p2, ports: [p1, p2, p3], wait: 250 })
  const C = await fero('f1own', { host: '127.0.0.1', port: p3, ports: [p1, p2, p3], wait: 250 })
  try {
    // Wait for the committed 3-node VIEW (the ring derives from it, Milestone V) —
    // not just raw connectivity — before computing owners.
    assert.ok(
      await until(() => A.cluster.members.length === 3 && B.cluster.members.length === 3 && C.cluster.members.length === 3, 8000),
      `view formed: ${A.cluster.members.length}/${B.cluster.members.length}/${C.cluster.members.length}`,
    )

    // A key OWNED BY B (not A). Writing it on A must FORWARD to B: A never
    // broadcasts it (the sink returns right after forwarding) and never logs it,
    // so C can ONLY receive it from B's own commit+broadcast — which proves B, the
    // owner, sequenced it. All three nodes agree on the owner (one ring).
    let key: string | undefined
    for (let i = 0; i < 2000 && !key; i++) if (A.cluster.owner('k' + i) === a2) key = 'k' + i
    assert.ok(key, 'found a B-owned key')
    assert.equal(B.cluster.owner(key!), a2, 'B agrees it owns the key')

    A.data[key!] = 'via-A'
    assert.ok(
      await until(() => B.data[key!][value] === 'via-A' && C.data[key!][value] === 'via-A', 8000),
      `B=${B.data[key!][value]} C=${C.data[key!][value]}`,
    )
  } finally {
    A.destroy()
    B.destroy()
    C.destroy()
  }
})

test('F1: a batch written on one node routes across owners and converges exactly', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('f1batch', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('f1batch', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'view [A,B] formed')

    // 30 keys split by the ring: A owns ~half (local commit), B owns ~half (A
    // forwards them to B, which commits and broadcasts back). Convergence to
    // EXACTLY the 30 keys on B proves no loss and no echo storm under forwarding.
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    const owners = new Set(keys.map((k) => A.cluster.owner(k)))
    assert.ok(owners.size >= 2, `batch spans both owners (got ${owners.size}) so forwarding is exercised`)

    for (const k of keys) A.data[k] = k
    const expected = Object.fromEntries(keys.map((k) => [k, k]))
    assert.ok(await until(() => sameState(B.data[value], expected), 8000), `B: ${Object.keys(B.data[value]).length}/30`)
    assert.ok(sameState(A.data[value], expected), 'A holds the full set too (canonical records returned)')
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('F1: concurrent writes to one key from both nodes serialize through the owner', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  const A = await fero('f1ser', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200 })
  const B = await fero('f1ser', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'view [A,B] formed')

    // Both nodes write the SAME key. Whoever owns it is the single sequencer; both
    // must converge to ONE identical value (linearizable per partition — vs the
    // pre-F1 model where each committed locally and LWW arbitrated after the fact).
    A.data.hot = 'A'
    B.data.hot = 'B'
    assert.ok(
      await until(() => {
        const va = A.data.hot[value]
        const vb = B.data.hot[value]
        return va !== undefined && va === vb
      }, 8000),
      `A=${A.data.hot[value]} B=${B.data.hot[value]}`,
    )
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('reciprocal catch-up: two nodes that each wrote while isolated both heal on connect', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  // Start A alone (knows nobody yet) and let it write before B exists.
  const A = await fero('recip', { host: '127.0.0.1', port: p1, ports: [p1], wait: 80 })
  A.data.fromA = 1
  // B starts knowing A; B also writes before they sync. Now EACH holds a record
  // the other lacks — so a one-directional digest would heal only one side.
  const B = await fero('recip', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 80 })
  B.data.fromB = 2
  try {
    const expected = { fromA: 1, fromB: 2 }
    assert.ok(await until(() => sameState(A.data[value], expected), 8000), `A: ${JSON.stringify(A.data[value])}`)
    assert.ok(await until(() => sameState(B.data[value], expected), 8000), `B: ${JSON.stringify(B.data[value])}`)
  } finally {
    A.destroy()
    B.destroy()
  }
})

// ── Milestone V1f: heal/rejoin + multi-node merge ──

test('V1f: an evicted node rejoins the cluster after restart', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = failoverCfg(p1, p2, p3)
  const A = await fero('vrejoin', cfg(p1))
  const B = await fero('vrejoin', cfg(p2))
  let C = await fero('vrejoin', cfg(p3))
  const cAddr = C.cluster.me as string
  try {
    assert.ok(await until(() => [A, B, C].every((n) => n.cluster.members.length === 3), 8000), 'view [A,B,C] forms')

    C.destroy() // C fails → evicted
    assert.ok(
      await until(() => [A, B].every((n) => n.cluster.members.length === 2 && !n.cluster.members.includes(cAddr)), 8000),
      'C is evicted',
    )
    const afterEvict = A.cluster.epoch

    C = await fero('vrejoin', cfg(p3)) // C restarts on the same address → must be re-admitted
    assert.ok(
      await until(() => [A, B, C!].every((n) => n.cluster.members.length === 3 && n.cluster.members.includes(cAddr)), 8000),
      `C rejoins: ${A.cluster.members.length}/${B.cluster.members.length}/${C.cluster.members.length}`,
    )
    assert.ok(A.cluster.epoch > afterEvict, 'rejoin bumped the epoch past the eviction')
  } finally {
    A.destroy()
    B.destroy()
    C.destroy()
  }
})

test('V1f: four nodes converge on a single committed view', async () => {
  const ps = [await ports.free(), await ports.free(), await ports.free(), await ports.free()]
  const nodes: Array<Awaited<ReturnType<typeof fero>>> = []
  for (const p of ps) nodes.push(await fero('v4', { host: '127.0.0.1', port: p, ports: ps, wait: 300 }))
  try {
    assert.ok(
      await until(() => nodes.every((n) => n.cluster.members.length === 4), 10000),
      `members: ${nodes.map((n) => n.cluster.members.length).join(',')}`,
    )
    const mem = JSON.stringify(nodes[0].cluster.members)
    assert.ok(nodes.every((n) => JSON.stringify(n.cluster.members) === mem), 'all four agree on the same committed view')
    assert.ok(nodes.every((n) => n.cluster.owner('probe') === nodes[0].cluster.owner('probe')), 'all rings agree on ownership')
  } finally {
    nodes.forEach((n) => n.destroy())
  }
})

// ── Milestone V1d: epoch fencing in LWW ──

test('V1d: a write committed under a newer view-epoch wins (epoch-fenced LWW)', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  // A starts solo (view [A]@1) and writes k under epoch 1.
  const A = await fero('vepoch', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 120 })
  A.data.k = 'epoch1'
  // B joins; the cluster merges to a higher epoch. B then writes k under it.
  const B = await fero('vepoch', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 120 })
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'merged')
    assert.ok(A.cluster.epoch >= 2, `epoch advanced past 1 (got ${A.cluster.epoch})`)
    B.data.k = 'epoch2' // committed under the newer epoch

    // both converge to the newer-epoch write (the (epoch, seq, origin) LWW order)
    assert.ok(
      await until(() => A.data.k[value] === 'epoch2' && B.data.k[value] === 'epoch2', 8000),
      `A=${A.data.k[value]} B=${B.data.k[value]}`,
    )
  } finally {
    A.destroy()
    B.destroy()
  }
})

test('V1d: epoch-aware catch-up SKIPS logging a record whose key already has a higher-epoch winner', async () => {
  // Drive applyInbound deterministically via the storage seam (restore replays each
  // loaded record through the same accept path as inbound replication / catch-up, in
  // array order). We stage, per key, a higher-epoch WINNER first, then a stale record:
  //   • key k — winner@epoch2, then a loser@epoch1 with a HIGHER seq: epoch dominates
  //     seq (V1d), so it's a PERMANENT loser → skipped (NOT logged).
  //   • key m — winner@epoch2 seq6, then a SAME-epoch loser@epoch2 seq3: a same-epoch
  //     loser still belongs to the per-origin history → it STAYS logged (just not applied).
  // A `_diag` method reaches Context.log (size + marks) to prove what was/wasn't logged.
  const records = [
    { type: 'update', key: ['k'], value: 'kw', origin: 'o-k-win', seq: 5, epoch: 2 },
    { type: 'update', key: ['k'], value: 'kl', origin: 'o-k-lose', seq: 9, epoch: 1 },
    { type: 'update', key: ['m'], value: 'mw', origin: 'o-m-win', seq: 6, epoch: 2 },
    { type: 'update', key: ['m'], value: 'ml', origin: 'o-m-lose', seq: 3, epoch: 2 },
  ] as any[]
  const A = await fero('eskip', {
    port: await ports.free(),
    wait: 30,
    storage: { load: async () => records, append: () => {} },
    _diag: (_: any, c: any) => ({ size: c.log.size, marks: c.log.marks() }),
  })
  try {
    const diag = await A.methods._diag()
    // winners applied (epoch-fenced LWW elected them regardless of arrival order)
    assert.equal(A.data.k[value], 'kw', `k = winner (got ${A.data.k[value]})`)
    assert.equal(A.data.m[value], 'mw', `m = winner (got ${A.data.m[value]})`)
    // 3 records logged: both winners + the same-epoch loser; the epoch-loser was SKIPPED.
    assert.equal(diag.size, 3, `epoch-loser skipped, same-epoch loser kept (log.size ${diag.size})`)
    assert.equal(diag.marks['o-k-lose'], undefined, 'the epoch-loser is NOT in the log (skipped, never appended)')
    assert.equal(diag.marks['o-m-lose'], 3, 'the same-epoch loser IS logged (per-origin history)')
  } finally {
    A.destroy()
  }
})

// ── Milestone V1e: write-gate (quorum-loss → read-only + buffer) ──

test('V1e: a node that loses quorum goes read-only and buffers writes, flushing on recovery', async () => {
  const [p1, p2] = [await ports.free(), await ports.free()]
  // evictAfter huge so the survivor does NOT evict the dead peer — we want it to
  // STAY a quorum-less minority of its [A,B] view while the peer is gone.
  const cfg = (port: number) => ({
    host: '127.0.0.1',
    port,
    ports: [p1, p2],
    wait: 200,
    heartbeat: { interval: 100, misses: 2 },
    view: { evictAfter: 100_000 },
  })
  const A = await fero('vgate', cfg(p1))
  let B = await fero('vgate', cfg(p2))
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'view [A,B] forms')
    assert.equal(A.cluster.writable, true, 'writable with a quorum')

    B.destroy() // A is now 1 of 2 — no quorum
    assert.ok(await until(() => A.cluster.writable === false, 5000), 'A goes read-only without quorum')

    A.data.x = 'written-while-readonly' // buffered, NOT committed/broadcast

    // B returns on the same address → A regains quorum → flushes the buffered write
    B = await fero('vgate', cfg(p2))
    assert.ok(await until(() => A.cluster.writable === true, 8000), 'A is writable again once quorum returns')
    assert.ok(await until(() => B.data.x[value] === 'written-while-readonly', 8000), `buffered write flushed to B: ${B.data.x[value]}`)
  } finally {
    A.destroy()
    B.destroy()
  }
})

// ── Milestone V1b: view-synchronous membership — merge + late-joiner ──

test('V1b: singletons merge into one committed view (ballot + joint-consensus quorum)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const A = await fero('vmerge', { host: '127.0.0.1', port: p1, ports: [p1, p2, p3], wait: 250 })
  const B = await fero('vmerge', { host: '127.0.0.1', port: p2, ports: [p1, p2, p3], wait: 250 })
  const C = await fero('vmerge', { host: '127.0.0.1', port: p3, ports: [p1, p2, p3], wait: 250 })
  try {
    // Three nodes that each boot as a solo view [self]@1 must converge on ONE
    // committed view of all three — the lowest-address coordinator proposes, the
    // others defer and ack, joint-consensus commits.
    assert.ok(
      await until(() => [A, B, C].every((n) => n.cluster.members.length === 3), 8000),
      `members: ${A.cluster.members.length}/${B.cluster.members.length}/${C.cluster.members.length}`,
    )
    // identical committed membership and epoch on every node
    const mem = JSON.stringify(A.cluster.members)
    assert.equal(JSON.stringify(B.cluster.members), mem, 'B sees the same members')
    assert.equal(JSON.stringify(C.cluster.members), mem, 'C sees the same members')
    assert.ok(A.cluster.epoch >= 2 && B.cluster.epoch === A.cluster.epoch && C.cluster.epoch === A.cluster.epoch, 'one agreed epoch')
    // identical rings → all agree on the owner of any key
    assert.ok(
      A.cluster.owner('probe') === B.cluster.owner('probe') && B.cluster.owner('probe') === C.cluster.owner('probe'),
      'rings agree on ownership',
    )
  } finally {
    A.destroy()
    B.destroy()
    C.destroy()
  }
})

// ── Milestone V1c: coordinator failover + eviction ──

const failoverCfg = (p1: number, p2: number, p3: number) => (port: number) => ({
  host: '127.0.0.1',
  port,
  ports: [p1, p2, p3],
  wait: 250,
  heartbeat: { interval: 100, misses: 2 }, // fast liveness detection
  view: { evictAfter: 300 }, // short eviction grace
})

test('V1c: killing the coordinator forms a new view without it (failover)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = failoverCfg(p1, p2, p3)
  const A = await fero('vfo', cfg(p1))
  const B = await fero('vfo', cfg(p2))
  const C = await fero('vfo', cfg(p3))
  const byAddr = new Map([A, B, C].map((n) => [n.cluster.me as string, n]))
  let survivors: Array<Awaited<ReturnType<typeof fero>>> | undefined
  try {
    assert.ok(await until(() => [A, B, C].every((n) => n.cluster.members.length === 3), 8000), 'view [A,B,C] forms')
    const epoch0 = A.cluster.epoch
    const coordAddr = [...A.cluster.members].sort()[0] // lowest address = the coordinator
    const coord = byAddr.get(coordAddr)!
    survivors = [A, B, C].filter((n) => n !== coord)

    coord.destroy() // kill the coordinator

    // the next-lowest reachable node takes over and commits a view EXCLUDING it
    assert.ok(
      await until(() => survivors!.every((n) => n.cluster.members.length === 2 && !n.cluster.members.includes(coordAddr)), 8000),
      `survivors: ${survivors!.map((n) => JSON.stringify(n.cluster.members)).join(' ')}`,
    )
    assert.ok(survivors[0].cluster.epoch > epoch0, 'failover bumped the epoch')
    assert.equal([...survivors[0].cluster.members].sort().join(), [...survivors[1].cluster.members].sort().join(), 'survivors agree')
  } finally {
    ;(survivors ?? [A, B, C]).forEach((n) => n.destroy())
  }
})

test('V1c: a failed non-coordinator member is evicted from the view', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = failoverCfg(p1, p2, p3)
  const A = await fero('vev', cfg(p1))
  const B = await fero('vev', cfg(p2))
  const C = await fero('vev', cfg(p3))
  const byAddr = new Map([A, B, C].map((n) => [n.cluster.me as string, n]))
  let survivors: Array<Awaited<ReturnType<typeof fero>>> | undefined
  try {
    assert.ok(await until(() => [A, B, C].every((n) => n.cluster.members.length === 3), 8000), 'view [A,B,C] forms')
    const victimAddr = [...A.cluster.members].sort()[2] // highest address = a non-coordinator
    const victim = byAddr.get(victimAddr)!
    survivors = [A, B, C].filter((n) => n !== victim)

    victim.destroy()

    assert.ok(
      await until(() => survivors!.every((n) => n.cluster.members.length === 2 && !n.cluster.members.includes(victimAddr)), 8000),
      `survivors: ${survivors!.map((n) => JSON.stringify(n.cluster.members)).join(' ')}`,
    )
  } finally {
    ;(survivors ?? [A, B, C]).forEach((n) => n.destroy())
  }
})

test('V1b: a late joiner is admitted to the committed view', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const A = await fero('vjoin', { host: '127.0.0.1', port: p1, ports: [p1, p2, p3], wait: 200 })
  const B = await fero('vjoin', { host: '127.0.0.1', port: p2, ports: [p1, p2, p3], wait: 200 })
  let C: Awaited<ReturnType<typeof fero>> | undefined
  try {
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), 'view [A,B] forms first')
    const epoch2 = A.cluster.epoch

    // C joins knowing ONLY A (ports:[p1]); the coordinator must fold it into a new
    // committed view that all three agree on, at a HIGHER epoch.
    C = await fero('vjoin', { host: '127.0.0.1', port: p3, ports: [p1], wait: 200 })
    assert.ok(
      await until(() => [A, B, C!].every((n) => n.cluster.members.length === 3), 8000),
      `admitted: ${A.cluster.members.length}/${B.cluster.members.length}/${C!.cluster.members.length}`,
    )
    assert.ok(A.cluster.epoch > epoch2, 'admitting C bumped the epoch')
    assert.ok(A.cluster.owner('probe') === C!.cluster.owner('probe'), 'C shares the ring')
  } finally {
    A.destroy()
    B.destroy()
    C?.destroy()
  }
})

// ── Milestone Q2a: owner-scoped aggregate PARTIAL primitive (no fan-out yet) ──
// The `aggregate` default method returns this node's partial for a distributed
// aggregate, computed over ONLY the partitions it OWNS. Because every partition has
// exactly one owner, the union of all holders' owner-scoped partials is a DISJOINT
// cover of the keyspace — each row counted once regardless of R (the dedup the fold
// in Q2b relies on). Here we prove the partial is owner-scoped and the cover is
// disjoint; the fold itself lands in Q2b.

test('Q2a: solo node owns everything — partial == full local aggregate', async () => {
  const r = await fero('q2a-solo', { port: await ports.free(), wait: 50 })
  try {
    let expected = 0
    for (let i = 0; i < 12; i++) {
      const v = (i * 5) % 7
      r.data['k' + i] = { v }
      expected += v
    }
    assert.equal(r.methods.aggregate({ op: 'sum', col: 'v' })[value], expected, 'sum over all owned keys')
    assert.equal(r.methods.aggregate({ op: 'count' })[value], 12, 'count')
    assert.equal(r.methods.aggregate({ op: 'max', col: 'v' })[value], 6, 'max')
    assert.equal(r.methods.aggregate({ op: 'min', col: 'v' })[value], 0, 'min')
  } finally {
    r.destroy()
  }
})

test('Q2a: holder partials are owner-scoped — Σ partials == global, each key once (R=2)', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: [p1, p2, p3], wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q2a', cfg(p1))
  const B = await fero('q2a', cfg(p2))
  const C = await fero('q2a', cfg(p3))
  const all = [A, B, C]
  const node = (addr: string) => all.find((n) => n.cluster.me === addr)!
  const formed = (n: any) => n.cluster.members.length === 3 && all.every((x) => x === n || connected(n.cluster, x.cluster.me))
  const has = (n: any, k: string) => k in (n.data[value] ?? {})
  try {
    assert.ok(await until(() => all.every(formed), 8000), 'cluster fully formed')
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    for (const k of keys) {
      const v = ((k.charCodeAt(1) * 7 + k.length) % 13) + 1
      vals[k] = v
      node(A.cluster.owner(k)!).data[k] = { v } // each key written by its owner
    }
    assert.ok(
      await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000),
      'every key placed on its full R-set',
    )

    // (1) each node's owner-scoped partial == sum of v over keys IT OWNS.
    for (const n of all) {
      const owned = keys.filter((k) => n.cluster.owner(k) === n.cluster.me)
      const expected = owned.reduce((s, k) => s + vals[k], 0)
      assert.equal(n.methods.aggregate({ op: 'sum', col: 'v' })[value], expected, `${n.cluster.me} owner-scoped sum`)
      assert.equal(n.methods.aggregate({ op: 'count' })[value], owned.length, `${n.cluster.me} owner-scoped count`)
    }

    // (2) DISJOINT cover: Σ owner-scoped partials == global sum/count (no double-count, no gap).
    const globalSum = keys.reduce((s, k) => s + vals[k], 0)
    const foldSum = all.reduce((s, n) => s + n.methods.aggregate({ op: 'sum', col: 'v' })[value], 0)
    assert.equal(foldSum, globalSum, 'Σ partials == global sum')
    const foldCount = all.reduce((s, n) => s + n.methods.aggregate({ op: 'count' })[value], 0)
    assert.equal(foldCount, keys.length, 'Σ partial counts == #keys (each counted once despite R=2)')

    // (3) a node EXCLUDES a key it holds as a non-owner replica.
    const witness = all.find((n) => keys.some((k) => has(n, k) && n.cluster.owner(k) !== n.cluster.me))!
    assert.ok(witness, 'some node holds a key it does not own')
    const heldNotOwned = keys.find((k) => has(witness, k) && witness.cluster.owner(k) !== witness.cluster.me)!
    const ownedSum = keys.filter((k) => witness.cluster.owner(k) === witness.cluster.me).reduce((s, k) => s + vals[k], 0)
    assert.equal(witness.methods.aggregate({ op: 'sum', col: 'v' })[value], ownedSum, `held-but-not-owned key ${heldNotOwned} excluded from ${witness.cluster.me}'s partial`)
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2a: empty-set identities (sum=0, count=0, max/min=undefined)', async () => {
  const r = await fero('q2a-empty', { port: await ports.free(), wait: 50 })
  try {
    assert.equal(r.methods.aggregate({ op: 'sum', col: 'v' })[value], 0, 'empty sum = 0')
    assert.equal(r.methods.aggregate({ op: 'count' })[value], 0, 'empty count = 0')
    assert.equal(r.methods.aggregate({ op: 'max', col: 'v' })[value], undefined, 'empty max = undefined')
    assert.equal(r.methods.aggregate({ op: 'min', col: 'v' })[value], undefined, 'empty min = undefined')
  } finally {
    r.destroy()
  }
})

// ── Milestone Q2b: fold combiner + facade terminals (sum/count/max/min) ──
// The querying side: `await data.sum('v')` gathers every holder's owner-scoped partial
// and folds to the global; reactive use refolds on each delta. The querying node folds
// its OWN shard in-process (it cannot subscribe to itself) — the self-routing fix.

const q2bForm = async (name: string, R: number, n = 3) => {
  const pts = await Promise.all(Array.from({ length: n }, () => ports.free()))
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: pts, wait: 250, replicas: R, antiEntropy: 150 })
  const all = await Promise.all(pts.map((p) => fero(name, cfg(p))))
  const node = (addr: string) => all.find((x) => x.cluster.me === addr)!
  const formed = (x: any) => x.cluster.members.length === n && all.every((y) => y === x || connected(x.cluster, y.cluster.me))
  const ok = await until(() => all.every(formed), 8000)
  return { all, node, ok }
}

test('Q2b: await data.sum/count folds the WHOLE resource incl. the querier’s own shard (R=2)', async () => {
  const { all, node, ok } = await q2bForm('q2b', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    for (const k of keys) {
      const v = ((k.charCodeAt(1) * 7 + k.length) % 13) + 1
      vals[k] = v
      node(A.cluster.owner(k)!).data[k] = { v }
    }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'every key on its R-set')
    const globalSum = keys.reduce((s, k) => s + vals[k], 0)

    // self-routing guard: A owns a non-empty shard, and the global INCLUDES it.
    const aShard = keys.filter((k) => A.cluster.owner(k) === A.cluster.me).reduce((s, k) => s + vals[k], 0)
    assert.ok(aShard > 0, 'querier A owns a non-empty shard')

    // every node, as coordinator, folds its own shard + peers' to the same global.
    for (const n of all) {
      let gotSum: any
      for (let i = 0; i < 40; i++) {
        gotSum = await n.data.sum('v')
        if (gotSum === globalSum) break
        await sleep(150)
      }
      assert.equal(gotSum, globalSum, `${n.cluster.me}: await data.sum folds whole resource (incl. own shard)`)
      let gotCount: any
      for (let i = 0; i < 40; i++) {
        gotCount = await n.data.length()
        if (gotCount === keys.length) break
        await sleep(150)
      }
      assert.equal(gotCount, keys.length, `${n.cluster.me}: await data.length() == #keys (each counted once despite R=2)`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2b: reactive data.sum().connect refolds on a single write (one delta → O(holders) recompute)', async () => {
  const { all, node, ok } = await q2bForm('q2br', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const keys = Array.from({ length: 12 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 2 }
    const base = keys.length * 2
    let last: any
    const agg = A.data.sum('v') // hold the handle so its subscriptions stay alive
    const host = agg.connect({}, (c: any) => {
      last = c.value
    })
    void host
    assert.ok(await until(() => last === base, 8000), `reactive fold converged to ${base}, got ${last}`)
    // a fresh write on its owner bumps the live global by exactly its value.
    node(A.cluster.owner('newk')!).data.newk = { v: 100 }
    assert.ok(await until(() => last === base + 100, 8000), `live fold tracked the write to ${base + 100}, got ${last}`)
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2b: global max/min skip empty-owned holders (undefined partials)', async () => {
  const { all, node, ok } = await q2bForm('q2bm', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    // ONE key exists → only its R-set holds it, only ONE node owns it; the other two
    // own zero written keys → their partial max/min is undefined and MUST be skipped.
    node(A.cluster.owner('solo')!).data.solo = { v: 42 }
    assert.ok(await until(() => A.cluster.replicas('solo').every((a) => has(node(a), 'solo')), 8000), 'solo on its R-set')
    for (const n of all) {
      let mx: any
      for (let i = 0; i < 40; i++) {
        mx = await n.data.max('v')
        if (mx === 42) break
        await sleep(150)
      }
      assert.equal(mx, 42, `${n.cluster.me}: max skips undefined partials from empty-owned holders`)
      assert.equal(await n.data.min('v'), 42, `${n.cluster.me}: min skips undefined too`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2b: a NaN partial (non-numeric column) propagates to the global sum — not masked to 0', async () => {
  // Regression for the `|| 0` → `?? 0` fix: data's SumValue poisons a holder's whole
  // owner-scoped partial to NaN on a non-numeric column value. The fold must PROPAGATE
  // NaN (matching the single-node R≥members path), not swallow it to 0 and return a
  // confidently-wrong finite number. We query the OWNER of the bad key so its NaN partial
  // is LOCAL (no wire NaN→null codec dependency).
  const { all, node, ok } = await q2bForm('q2bnan', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 20 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 3 }
    const bad = 'oops'
    node(A.cluster.owner(bad)!).data[bad] = { v: 'not-a-number' } // poisons its owner's partial → NaN
    assert.ok(await until(() => has(node(A.cluster.owner(bad)!), bad), 8000), 'bad key on its owner')
    const owner = node(A.cluster.owner(bad)!)
    let got: any
    for (let i = 0; i < 30; i++) {
      got = await owner.data.sum('v')
      if (typeof got === 'number' && Number.isNaN(got)) break
      await sleep(120)
    }
    assert.ok(Number.isNaN(got), `owner's distributed sum is NaN (propagated, not masked to a finite ${got})`)
  } finally {
    all.forEach((n) => n.destroy())
  }
})

// ── Milestone Q2c: view-change rebind + holder churn + acquisition heal ──
// A live fold must survive membership changes: each node re-scopes its own owner-scoped
// partials on its own commit, the coordinator reconciles its holder set (add new / drop
// departed / retry the admit race), and acquired partitions heal in. The data is UNCHANGED
// across the churn, so the fold must settle back to EXACTLY the same global — any permanent
// deviation is a double-count (re-scope failed) or a gap (reconcile/acquisition failed).

test('Q2c: a live fold survives a node JOIN — re-scopes + reconciles, settles to the same global', async () => {
  const pts = await Promise.all(Array.from({ length: 4 }, () => ports.free()))
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: pts, wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q2cg', cfg(pts[0]))
  const B = await fero('q2cg', cfg(pts[1]))
  const C = await fero('q2cg', cfg(pts[2]))
  let D: any
  const node = (addr: string) => [A, B, C, D].find((n) => n && n.cluster.me === addr)!
  const formed3 = (n: any) => n.cluster.members.length === 3 && [A, B, C].every((x) => x === n || connected(n.cluster, x.cluster.me))
  let last: any
  let agg: any
  let host: any
  try {
    assert.ok(await until(() => [A, B, C].every(formed3), 8000), '3-node formed')
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 5 }
    const globalSum = keys.length * 5
    agg = A.data.sum('v') // hold the handle alive
    host = agg.connect({}, (c: any) => {
      last = c.value
    })
    void host
    assert.ok(await until(() => last === globalSum, 8000), `fold converged pre-join: ${last}/${globalSum}`)

    D = await fero('q2cg', cfg(pts[3])) // a 4th node joins → ring rebalances onto it
    assert.ok(await until(() => [A, B, C, D].every((n) => n.cluster.members.length === 4), 12000), '4-node view committed')
    // data UNCHANGED → after rebalance + D's acquisition + every node's re-scope, the fold
    // must settle back to EXACTLY globalSum (no double-count from a stale owner, no gap).
    assert.ok(await until(() => last === globalSum, 15000), `fold held the global after join: ${last}/${globalSum}`)
  } finally {
    ;[A, B, C, D].forEach((n) => {
      try {
        n && n.destroy()
      } catch {}
    })
  }
})

test('Q2c: killing a holder drops its shard + survivors re-scope — fold heals to the global', async () => {
  const { all, node, ok } = await q2bForm('q2ck', 2)
  const [A, B, C] = all
  let last: any
  let agg: any
  let host: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 5 }
    const globalSum = keys.length * 5
    agg = A.data.sum('v')
    host = agg.connect({}, (c: any) => {
      last = c.value
    })
    void host
    assert.ok(await until(() => last === globalSum, 8000), `fold converged: ${last}/${globalSum}`)

    C.destroy() // kill a holder that is NOT the coordinator (A); R=2 ⇒ no partition was only on C
    assert.ok(
      await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 14000),
      `C evicted → 2-member view (${A.cluster.members.length}/${B.cluster.members.length})`,
    )
    // survivors {A,B} re-ring (R≥2 members ⇒ both hold all), acquire C's old partitions from
    // each other's surviving replica, re-scope ownership, and the fold drops C's stale shard —
    // healing back to globalSum (no data lost).
    assert.ok(await until(() => last === globalSum, 15000), `fold healed after kill: ${last}/${globalSum}`)
  } finally {
    ;[A, B].forEach((n) => {
      try {
        n.destroy()
      } catch {}
    })
  }
})

// ── Milestone Q2d: avg ({sum,count} pair) + some/every (declarative OR/AND) ──

test('Q2d: global avg folds (sum,count) pairs and divides last — not average-of-averages', async () => {
  const { all, node, ok } = await q2bForm('q2davg', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    for (const k of keys) {
      const v = ((k.charCodeAt(1) * 13 + k.length * 7) % 50) + 1
      vals[k] = v
      node(A.cluster.owner(k)!).data[k] = { v }
    }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    const globalAvg = keys.reduce((s, k) => s + vals[k], 0) / keys.length
    for (const n of all) {
      let got: any
      for (let i = 0; i < 40; i++) {
        got = await n.data.avg('v')
        if (typeof got === 'number' && Math.abs(got - globalAvg) < 1e-9) break
        await sleep(120)
      }
      assert.ok(typeof got === 'number' && Math.abs(got - globalAvg) < 1e-9, `${n.cluster.me}: avg=${got} expected ${globalAvg}`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2d: global some/every over a declarative predicate (OR / AND)', async () => {
  const { all, node, ok } = await q2bForm('q2dse', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 20 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { active: true }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    for (const n of all) {
      assert.equal(await n.data.some('active'), true, `${n.cluster.me}: some(active) = true (a match exists)`)
      assert.equal(await n.data.every('active'), true, `${n.cluster.me}: every(active) = true (all match)`)
    }
    // flip ONE key inactive on its owner → some stays true, every flips false.
    node(A.cluster.owner('k5')!).data.k5 = { active: false }
    assert.ok(await until(() => (node(A.cluster.owner('k5')!).data[value] as any)?.k5?.active === false, 8000), 'k5 flipped')
    for (const n of all) {
      let s: any
      let e: any
      for (let i = 0; i < 40; i++) {
        s = await n.data.some('active')
        e = await n.data.every('active')
        if (s === true && e === false) break
        await sleep(120)
      }
      assert.equal(s, true, `${n.cluster.me}: some still true (others active)`)
      assert.equal(e, false, `${n.cluster.me}: every now false (k5 inactive)`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2d: a closure predicate on the facade is rejected loudly (local fallback, not silent)', async () => {
  const { all, ok } = await q2bForm('q2drej', 2)
  const orig = console.warn
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const warnings: string[] = []
    console.warn = (...a: unknown[]) => warnings.push(a.join(' '))
    void A.data.some((s: any) => s.active) // a closure can't cross the wire → warn + local fallback
    console.warn = orig
    assert.ok(warnings.some((w) => w.includes("can't be distributed")), `closure rejected loudly; warnings=${JSON.stringify(warnings)}`)
  } finally {
    console.warn = orig
    all.forEach((n) => n.destroy())
  }
})

// ── Milestone Q2e: client server-as-coordinator ──
// A read-only client can't owner-scope or fold (no me/view/ring). Its facade aggregates
// route to its one connected server, which builds the fold and streams the GLOBAL back.

test('Q2e: a read-only client gets GLOBAL aggregates via server-as-coordinator', async () => {
  const { all, node, ok } = await q2bForm('q2ec', 2)
  const A = all[0]
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    for (const k of keys) {
      const v = (k.charCodeAt(1) % 9) + 1
      vals[k] = v
      node(A.cluster.owner(k)!).data[k] = { v }
    }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    const globalSum = keys.reduce((s, k) => s + vals[k], 0)
    const globalAvg = globalSum / keys.length

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q2ec', { host: '127.0.0.1', ports: [pA], wait: 200 }) // dials ONLY A
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    // await: global sum / count / avg, folded by A on the client's behalf.
    let s: any
    for (let i = 0; i < 40; i++) {
      s = await client.data.sum('v')
      if (s === globalSum) break
      await sleep(150)
    }
    assert.equal(s, globalSum, 'client await data.sum() == global')
    let c: any
    for (let i = 0; i < 40; i++) {
      c = await client.data.length()
      if (c === keys.length) break
      await sleep(150)
    }
    assert.equal(c, keys.length, 'client await data.length() == global count')
    let av: any
    for (let i = 0; i < 40; i++) {
      av = await client.data.avg('v')
      if (typeof av === 'number' && Math.abs(av - globalAvg) < 1e-9) break
      await sleep(150)
    }
    assert.ok(typeof av === 'number' && Math.abs(av - globalAvg) < 1e-9, `client await data.avg() == global avg (${av}/${globalAvg})`)

    // reactive: the server streams the live global to the client.
    let last: any
    const agg = client.data.sum('v')
    const host = agg.connect({}, (ch: any) => {
      last = ch.value
    })
    void host
    assert.ok(await until(() => last === globalSum, 10000), `client reactive sum converged: ${last}/${globalSum}`)
    node(A.cluster.owner('zz')!).data.zz = { v: 1000 } // a fresh write anywhere
    assert.ok(await until(() => last === globalSum + 1000, 10000), `client reactive tracked the write: ${last}`)
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

// ── Milestone Q2f: Q3 boundary guard ──
// Holistic / ordered operators (az/za/top/limit, group, distinct, reduce) can't fold from
// per-shard partials. On a scoped facade they return a LOCAL result but warn LOUDLY (once
// per op) so they're never silently mistaken for the global answer.

test('Q2f: a holistic op on the facade is loudly flagged (local result, never silent)', async () => {
  const { all, ok } = await q2bForm('q2f', 2)
  const orig = console.warn
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const warnings: string[] = []
    console.warn = (...a: unknown[]) => warnings.push(a.join(' '))
    void A.data.za('v') // ordered (descending sort) → holistic
    void A.data.group('country') // grouped → needs L3 planner
    void A.data.top('v', 5) // top-K → holistic (move-deltas applyRecord ignores)
    console.warn = orig
    assert.ok(warnings.some((w) => w.includes('HOLISTIC') && w.includes('za')), `za flagged; warnings=${warnings.length}`)
    assert.ok(warnings.some((w) => w.includes('group')), 'group flagged')
    assert.ok(warnings.some((w) => w.includes('top')), 'top flagged')
    // decomposable aggregates do NOT warn (they distribute) — sanity that the guard is scoped to holistic.
    const before = warnings.length
    console.warn = (...a: unknown[]) => warnings.push(a.join(' '))
    void A.data.sum('v')
    console.warn = orig
    assert.equal(warnings.length, before, 'sum did not warn (it distributes)')
  } finally {
    console.warn = orig
    all.forEach((n) => n.destroy())
  }
})

// ── Q2 capstone regressions (found by the integrated-surface review) ──

test('Q2 regression: some/every(col) work at R≥viewSize (no "fn is not a function" crash)', async () => {
  // The R≥members branch must NOT forward a column STRING to data's raw some/every (which
  // need a predicate FN) — it routes through the fold instead. Solo R=3 (single-member
  // view) and a 2-node R=2 (every node holds all) both hit R≥viewSize.
  const solo = await fero('q2reg-solo', { host: '127.0.0.1', port: await ports.free(), wait: 50, replicas: 3 })
  try {
    solo.data.a = { active: true }
    solo.data.b = { active: true }
    assert.equal(await solo.data.some('active'), true, 'solo some(col)')
    assert.equal(await solo.data.every('active'), true, 'solo every(col)')
    solo.data.c = { active: false }
    await sleep(80)
    assert.equal(await solo.data.every('active'), false, 'solo every(col) flips false')
    assert.equal(await solo.data.some('active'), true, 'solo some(col) still true')
  } finally {
    solo.destroy()
  }

  const { all, node, ok } = await q2bForm('q2reg2', 2, 2) // 2 nodes, R=2 ⇒ R≥members
  try {
    assert.ok(ok, '2-node cluster formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 12 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { active: true }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    for (const n of all) {
      assert.equal(await n.data.some('active'), true, `${n.cluster.me}: some(col) at R≥members`)
      assert.equal(await n.data.every('active'), true, `${n.cluster.me}: every(col) at R≥members`)
    }
    node(A.cluster.owner('k3')!).data.k3 = { active: false }
    for (const n of all) {
      let e: any
      for (let i = 0; i < 40; i++) {
        e = await n.data.every('active')
        if (e === false) break
        await sleep(120)
      }
      assert.equal(e, false, `${n.cluster.me}: every(col) flips false across both owners`)
    }
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q2 regression: avg propagates a NaN local shard (not masked to 0)', async () => {
  // avgRule uses `?? 0` (not `|| 0`) on .sum, mirroring sumRule — a NaN-poisoned local
  // partial propagates to the global, matching single-node `data.avg`. Query the OWNER of
  // the bad key so its NaN partial is LOCAL (no wire NaN→null codec dependency).
  const { all, node, ok } = await q2bForm('q2regnan', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 16 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 4 }
    const bad = 'oops'
    node(A.cluster.owner(bad)!).data[bad] = { v: 'not-a-number' }
    assert.ok(await until(() => has(node(A.cluster.owner(bad)!), bad), 8000), 'bad key on its owner')
    const owner = node(A.cluster.owner(bad)!)
    let got: any
    for (let i = 0; i < 30; i++) {
      got = await owner.data.avg('v')
      if (typeof got === 'number' && Number.isNaN(got)) break
      await sleep(120)
    }
    assert.ok(Number.isNaN(got), `owner's distributed avg is NaN (propagated, not masked to ${got})`)
  } finally {
    all.forEach((n) => n.destroy())
  }
})

// ── Milestone Q3a: whole-resource read() as a distributed gather ──
// Under scoping no single node holds the whole resource, so read() with NO key GATHERS — it
// folds every holder's owner-scoped rows into the union (the "download everything" step the
// user chains holistic ops after). A client gets it via server-as-coordinator; the contacted
// server, holding only its R-set, would otherwise return a silent PARTIAL.

test('Q3a: a client read() gathers the WHOLE resource, not just the contacted server’s shard', async () => {
  const { all, node, ok } = await q2bForm('q3a', 2)
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 30 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: k.length }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    // The contacted server A holds only its R-set (R=2 of 3 nodes) — it is MISSING some keys
    // locally. Without the gather a client read() would inherit that partial; with it, all 30.
    const aLocal = A.data[value] ?? {}
    const missingAtA = keys.filter((k) => !(k in aLocal))
    assert.ok(missingAtA.length > 0, `A does not hold the whole resource locally (missing ${missingAtA.length})`)

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q3a', { host: '127.0.0.1', ports: [pA], wait: 200 }) // dials ONLY A
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    // await client.methods.read() → the GLOBAL snapshot (A folds every holder's owned rows).
    let snap: any
    for (let i = 0; i < 40; i++) {
      snap = await client.methods.read()
      if (snap && keys.every((k) => k in snap)) break
      await sleep(150)
    }
    assert.ok(snap && keys.every((k) => k in snap), `client read() has all ${keys.length} keys (got ${Object.keys(snap ?? {}).length})`)
    assert.equal(Object.keys(snap).length, keys.length, 'no extra/duplicated keys (disjoint owner cover)')
    assert.deepEqual(snap[missingAtA[0]], { v: missingAtA[0].length }, 'a key A does NOT hold locally is present in the gather')
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('Q3a: a client’s reactive read() streams the live gather and tracks a fresh write anywhere', async () => {
  const { all, node, ok } = await q2bForm('q3ar', 2)
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 18 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 1 }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q3ar', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    const view = client.methods.read() // reactive (not awaited) ⇒ live gather subscription
    assert.ok(await until(() => keys.every((k) => k in (view[value] ?? {})), 10000), `live gather converged: ${Object.keys(view[value] ?? {}).length}/${keys.length}`)

    // a fresh write on its owner (a key whose owner may NOT be A) shows up live in the gather.
    node(A.cluster.owner('fresh')!).data.fresh = { v: 99 }
    assert.ok(await until(() => (view[value] ?? {}).fresh?.v === 99, 10000), `live gather tracked the write: ${JSON.stringify((view[value] ?? {}).fresh)}`)
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('Q3a: a reactive read() opened at members≤R re-arms the gather when the cluster grows past R', async () => {
  // Q3a-review regression (confirmed major): the reactive gather subscribe branch must NOT be
  // gated on R<viewSize() at subscribe time. A client opening read() while members≤R (the
  // contacted server momentarily holds everything) would otherwise stream that server's LOCAL
  // c.data forever and go SILENTLY PARTIAL once a join shards the resource and the server sheds
  // keys. gatherLive's reconcileMembers re-arms on each commit — so the gather tracks growth.
  const pts = await Promise.all(Array.from({ length: 3 }, () => ports.free()))
  const cfg = (port: number) => ({ host: '127.0.0.1', port, ports: pts, wait: 250, replicas: 2, antiEntropy: 150 })
  const A = await fero('q3grow', cfg(pts[0]))
  const B = await fero('q3grow', cfg(pts[1]))
  let C: any, client: any
  const live: any[] = [A, B]
  try {
    // 2-member view: members(2) ≤ R(2) ⇒ the OLD gate (R<viewSize) was FALSE at subscribe time.
    assert.ok(await until(() => A.cluster.members.length === 2 && B.cluster.members.length === 2, 8000), '2-member view formed')

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q3grow', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    // open the reactive gather while members ≤ R, and confirm it converges.
    A.data.seed = { v: 1 }
    const view = client.methods.read()
    assert.ok(await until(() => (view[value] ?? {}).seed?.v === 1, 8000), 'reactive gather converged at members≤R')

    // grow past R: a 3rd node joins ⇒ members(3) > R(2) ⇒ the resource shards.
    C = await fero('q3grow', cfg(pts[2]))
    live.push(C)
    const all = [A, B, C]
    assert.ok(await until(() => all.every((n) => n.cluster.members.length === 3), 12000), 'view grew to 3 members')
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client still on A after the join')

    // a key whose R-set EXCLUDES A — A no longer holds it, so a stale local-c.data stream WOULD miss it.
    const node = (addr: string) => all.find((x) => x.cluster.me === addr)!
    let k = ''
    for (let i = 0; i < 1000; i++) {
      const cand = 'g' + i
      if (!A.cluster.replicas(cand).includes(A.cluster.me!)) { k = cand; break }
    }
    assert.ok(k, 'found a key whose R-set excludes A')
    node(A.cluster.owner(k)!).data[k] = { v: 42 }

    // the live gather must surface it despite A not holding it — proof the gather re-armed on growth.
    assert.ok(await until(() => (view[value] ?? {})[k]?.v === 42, 12000), `live gather surfaced a non-A-held key after growth: ${JSON.stringify((view[value] ?? {})[k])}`)
    assert.equal((view[value] ?? {}).seed?.v, 1, 'original key still present')
  } finally {
    client?.destroy()
    live.forEach((n) => n.destroy())
  }
})

// ── Milestone Q3b: holistic ops AFTER a server's own read() (the headline capability) ──
// A scoped SERVER holds only its R-set, so its own methods.read() (no key) must GATHER the whole
// resource; the holistic operator then runs LOCALLY over the gathered proxy — a closure that
// never crosses the wire. This is the "download everything, then sort/reduce/distinct" path.

test('Q3b: methods.read().az(v) on a scoped server returns the GLOBAL sorted order', async () => {
  const { all, node, ok } = await q2bForm('q3baz', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    keys.forEach((k, i) => (vals[k] = (i * 7 + 3) % 53)) // step 7 mod 53 ⇒ all distinct ⇒ unambiguous order
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: vals[k] }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    // A holds only its R-set locally — its RAW data.az would be a partial. read() gathers first.
    const aLocal = A.data[value] ?? {}
    assert.ok(keys.some((k) => !(k in aLocal)), 'A does not hold the whole resource locally')
    const expected = keys.map((k) => vals[k]).sort((a, b) => a - b)

    const handle = A.methods.read() // server's own whole-resource read = gather
    const sorted = handle.az('v') // holistic op AFTER read, over the gathered proxy (runs locally)
    void sorted.connect([]) // keep the filter→sort chain alive (FunctionSink doesn't back-ref)
    let got: number[] = []
    for (let i = 0; i < 80; i++) {
      const snap = sorted[value]
      if (Array.isArray(snap) && snap.length === keys.length) {
        got = snap.map((r: any) => r.v)
        if (got.length === expected.length && got.every((v, j) => v === expected[j])) break
      }
      await sleep(150)
    }
    assert.deepEqual(got, expected, 'global ascending order over the gathered resource (not A’s local shard)')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q3b: methods.read().reduce(fn) folds the whole gathered resource (general closure, runs locally)', async () => {
  const { all, node, ok } = await q2bForm('q3bred', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 20 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    for (const k of keys) {
      vals[k] = (k.charCodeAt(1) * 3 + k.length) % 17
      node(A.cluster.owner(k)!).data[k] = { v: vals[k] }
    }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    const globalSum = keys.reduce((s, k) => s + vals[k], 0)

    const handle = A.methods.read()
    // a GENERAL fold via an arbitrary closure — impossible to ship to holders, correct here
    // because read() gathered the rows and the closure runs LOCALLY on the merged proxy.
    const folded = handle.reduce((acc: number, row: any) => acc + (row?.v ?? 0), 0)
    let got: any
    const host = folded.connect({}, (c: any) => (got = c.value)) // scalar ⇒ function sink (XU0)
    void host
    for (let i = 0; i < 80; i++) {
      if (got === globalSum) break
      await sleep(150)
    }
    assert.equal(got, globalSum, 'reduce folded the WHOLE gathered resource (not A’s local shard)')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

// ── Q3b capstone regressions (found by the adversarial review) ──

test('Q3b regression (M1): a custom no-key read is NOT swapped for the raw gather under scoping', async () => {
  // The gather override must replace only the DEFAULT read. A user-supplied read is THEIR projection;
  // swapping it for the raw gather under scoping (but not full-rep) is silent, mode-dependent wrong data.
  const pts = await Promise.all(Array.from({ length: 3 }, () => ports.free()))
  let calls = 0
  const cfg = (port: number) => ({
    host: '127.0.0.1',
    port,
    ports: pts,
    wait: 250,
    replicas: 2,
    antiEntropy: 150,
    read: (arg: any, c: any) => (typeof arg === 'string' ? c.data[arg] : ((calls++, c.data.filter((r: any) => r?.keep === true)))),
  })
  const all = await Promise.all(pts.map((p) => fero('q3m1', cfg(p))))
  const node = (addr: string) => all.find((x) => x.cluster.me === addr)!
  try {
    assert.ok(await until(() => all.every((x) => x.cluster.members.length === 3), 8000), 'formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 18 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { keep: k.charCodeAt(1) % 2 === 0 } // ~half keep:true
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    const before = calls
    const view = A.methods.read() // custom no-key read ⇒ generic surface, NOT the gather handle
    await sleep(300) // give any (incorrect) gather a chance to populate keep:false rows
    const snap = view[value] ?? {}
    assert.ok(calls > before, 'custom read handler ran (the gather did NOT bypass it)')
    assert.ok(
      Object.values(snap).every((r: any) => r?.keep === true),
      `custom filter applied — no keep:false rows leaked (got ${JSON.stringify(snap)})`,
    )
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q3b regression (M2): a handler returning c.methods.read() replies with the GLOBAL, not a local partial', async () => {
  // forWire() must resolve a returned gather handle via gatherOnce (await ⇒ global) instead of
  // opening its live fold and reading the still-empty in-progress union.
  const pts = await Promise.all(Array.from({ length: 3 }, () => ports.free()))
  const cfg = (port: number) => ({
    host: '127.0.0.1',
    port,
    ports: pts,
    wait: 250,
    replicas: 2,
    antiEntropy: 150,
    whole: (_arg: any, c: any) => c.methods.read(), // returns the gather handle
  })
  const all = await Promise.all(pts.map((p) => fero('q3m2', cfg(p))))
  const node = (addr: string) => all.find((x) => x.cluster.me === addr)!
  let client: any
  try {
    assert.ok(await until(() => all.every((x) => x.cluster.members.length === 3), 8000), 'formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 24 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: k.length }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    assert.ok(keys.some((k) => !(k in (A.data[value] ?? {}))), 'A is missing some keys locally')

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q3m2', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected')

    let snap: any
    for (let i = 0; i < 40; i++) {
      snap = await client.methods.whole()
      if (snap && keys.every((k) => k in snap)) break
      await sleep(150)
    }
    assert.ok(snap && keys.every((k) => k in snap), `handler RPC returned the whole resource (${Object.keys(snap ?? {}).length}/${keys.length})`)
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('Q3b regression (M3): a scoped server methods.read() is memoized to ONE gather handle (no per-call fold leak)', async () => {
  // A fresh foldAggregate per reactive call would leak an O(resource) union-fold into
  // aggregateReconciles, re-run every commit + AE tick, forever. Memoize to one handle per node.
  const { all, ok } = await q2bForm('q3m3', 2)
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    assert.strictEqual(A.methods.read(), A.methods.read(), 'same memoized gather handle across calls')
  } finally {
    all.forEach((n) => n.destroy())
  }
})

test('Q3 capstone: a CLIENT chains a holistic op over its gathered read() — client.methods.read().az(v) = global order', async () => {
  // The headline consumer shape (capstone test-gap fill): a read-only client gathers the whole
  // resource via its server (server-as-coordinator) and runs the holistic op LOCALLY over the
  // client-gathered proxy — same machinery as the server path, but the common case.
  const { all, node, ok } = await q2bForm('q3cli', 2)
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 20 }, (_, i) => 'k' + i)
    const vals: Record<string, number> = {}
    keys.forEach((k, i) => (vals[k] = (i * 7 + 3) % 53)) // distinct ⇒ unambiguous order
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: vals[k] }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')
    const expected = keys.map((k) => vals[k]).sort((a, b) => a - b)

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('q3cli', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected')

    const handle = client.methods.read() // client gather (server-as-coordinator)
    const sorted = handle.az('v') // holistic op over the client-gathered proxy, run locally
    void sorted.connect([])
    let got: number[] = []
    for (let i = 0; i < 80; i++) {
      const snap = sorted[value]
      if (Array.isArray(snap) && snap.length === keys.length) {
        got = snap.map((r: any) => r.v)
        if (got.length === expected.length && got.every((v, j) => v === expected[j])) break
      }
      await sleep(150)
    }
    assert.deepEqual(got, expected, 'client global ascending order over the gathered resource')
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

// ── Subscription hygiene: reap a gone peer's served subscriptions ──
// Served subscriptions are torn down on an explicit UNSUBSCRIBE frame. An UNGRACEFUL disconnect (a
// socket drop) never sends one — so without onPeerGone reaping, a dropped client/coordinator leaks
// its sinks and (worst) its Q3-gather / Q2-fold openFolds, each pinning an aggregateReconciles entry
// re-run every commit + AE tick forever.

test('subscription hygiene: an ungraceful peer drop reaps ALL its served subscriptions (gather + fold, no leak)', async () => {
  const { all, node, ok } = await q2bForm('reap', 2)
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 12 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 2 }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('reap', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected to A')

    // open TWO server-pushed subscriptions on A: a reactive whole-resource gather AND an aggregate
    // fold — A serves both (each an gatherLive), so the reverse-index reap must drop MORE than one.
    const view = client.methods.read()
    const agg = client.data.sum('v')
    void agg.connect({}, () => {})
    assert.ok(await until(() => Object.keys(view[value] ?? {}).length === keys.length, 10000), 'gather streaming to the client')
    assert.ok(await until(() => (A as any)[diagnostics].servedSubscriptions() >= 2, 10000), `A serves the client's gather + fold (${(A as any)[diagnostics].servedSubscriptions()})`)

    // ABRUPT drop: the CLIENT closes its link to A (A's listen address — unambiguous) with no
    // UNSUBSCRIBE. A sees the socket close → onPeerGone(the client's inbound address) → reapPeer.
    assert.ok((client as any)[diagnostics].drop(A.cluster.me), 'client dropped its connection to A')
    assert.ok(
      await until(() => (A as any)[diagnostics].servedSubscriptions() === 0, 8000),
      `A reaped every served sub for the dropped peer (now ${(A as any)[diagnostics].servedSubscriptions()})`,
    )
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('subscription hygiene: a GRACEFUL client.destroy() also leaves no served subscriptions (idempotent with onPeerGone)', async () => {
  // Graceful teardown sends UNSUBSCRIBE (serveUnsubscribe) AND drops the socket (onPeerGone→reapPeer):
  // both must coexist without double-free / crash, ending at zero served subs.
  const { all, node, ok } = await q2bForm('reapg', 2)
  let client: any
  try {
    assert.ok(ok, 'cluster fully formed')
    const A = all[0]
    const has = (x: any, k: string) => k in (x.data[value] ?? {})
    const keys = Array.from({ length: 8 }, (_, i) => 'k' + i)
    for (const k of keys) node(A.cluster.owner(k)!).data[k] = { v: 1 }
    assert.ok(await until(() => keys.every((k) => A.cluster.replicas(k).every((a) => has(node(a), k))), 8000), 'placed')

    const pA = +A.cluster.me!.split(':')[1]
    client = await fero('reapg', { host: '127.0.0.1', ports: [pA], wait: 200 })
    assert.ok(await until(() => connected(client.cluster, A.cluster.me), 6000), 'client connected')
    const view = client.methods.read()
    assert.ok(await until(() => Object.keys(view[value] ?? {}).length === keys.length, 10000), 'gather streaming')
    assert.ok(await until(() => (A as any)[diagnostics].servedSubscriptions() >= 1, 10000), 'A serves the gather')

    client.destroy() // graceful: UNSUBSCRIBE frames + socket close
    client = undefined
    assert.ok(await until(() => (A as any)[diagnostics].servedSubscriptions() === 0, 6000), `A has no leaked subs after graceful destroy (${(A as any)[diagnostics].servedSubscriptions()})`)
  } finally {
    client?.destroy()
    all.forEach((n) => n.destroy())
  }
})

test('log compaction: a high-churn key collapses in-memory; data + a fresh joiner stay correct', async () => {
  const [p1, p2, p3] = [await ports.free(), await ports.free(), await ports.free()]
  const a1 = `127.0.0.1:${p1}`
  const a2 = `127.0.0.1:${p2}`
  // compact:false → no background pass fires; the test drives compaction deterministically via [diagnostics].compact()
  const A = await fero('compact', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 150, compact: false })
  const B = await fero('compact', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 150, compact: false })
  let C: Awaited<ReturnType<typeof fero>> | undefined
  try {
    assert.ok(await until(() => connected(A.cluster, a2) && connected(B.cluster, a1)), 'A↔B connect')

    // rewrite ONE key 200× (each rewrite is an `update` — the owner sequences them under one origin),
    // plus two stable keys. The logs accumulate every rewrite; only the latest is live.
    const CHURN = 200
    for (let i = 0; i < CHURN; i++) A.data.hot = i
    A.data.s1 = 'a'
    A.data.s2 = 'b'
    const expected = { hot: CHURN - 1, s1: 'a', s2: 'b' }
    assert.ok(await until(() => sameState(A.data[value], expected) && sameState(B.data[value], expected), 8000), `A,B converge: ${JSON.stringify(B.data[value])}`)

    // both logs hold the full churn history (≥ CHURN records) before compaction
    assert.ok(await until(() => (A as any)[diagnostics].logSize() >= CHURN, 8000), `A log grew to ${(A as any)[diagnostics].logSize()}`)
    const beforeA = (A as any)[diagnostics].logSize()

    // compact both nodes — the superseded `hot` updates collapse to one (per origin), stable keys + the
    // creating insert survive. logSize drops to a handful; the live proxy is untouched.
    const droppedA = (A as any)[diagnostics].compact()
    const droppedB = (B as any)[diagnostics].compact()
    assert.ok(droppedA >= CHURN - 2, `A dropped the churn history (${droppedA} of ${beforeA})`)
    assert.ok((A as any)[diagnostics].logSize() <= 5, `A log collapsed to ${(A as any)[diagnostics].logSize()}`)
    assert.ok((B as any)[diagnostics].logSize() <= 5, `B log collapsed to ${(B as any)[diagnostics].logSize()}`)
    assert.ok(droppedB >= CHURN - 2, `B dropped the churn history (${droppedB})`)
    assert.ok(sameState(A.data[value], expected) && sameState(B.data[value], expected), 'live state unchanged by compaction')

    // a fresh node catching up FROM the compacted logs still converges to the live state
    C = await fero('compact', { host: '127.0.0.1', port: p3, ports: [p1], wait: 150, compact: false })
    assert.ok(await until(() => sameState(C!.data[value], expected), 8000), `C caught up from a compacted log to ${JSON.stringify(C!.data[value])}`)

    // and a post-compaction write still replicates everywhere
    A.data.hot = 999
    assert.ok(await until(() => B.data.hot[value] === 999 && C!.data.hot[value] === 999, 8000), 'a write after compaction still replicates')
  } finally {
    A.destroy()
    B.destroy()
    C?.destroy()
  }
})

test('write-after-destroy is inert: no commit, no log growth, no WAL append', async () => {
  // Regression: destroy() never detached the write-capture sink or the storage onAppend hook
  // (data's FunctionSink has no public detach), so a late `r.data.x = y` still committed —
  // bumping the Lamport clock, mutating seen/versions, appending to the log, and fsyncing to
  // the WAL — silently, on a torn-down node.
  const path = join(os.tmpdir(), `fero-late-${randomUUID()}.log`)
  try {
    const r: any = await fero('late-write', { port: await ports.free(), wait: 10, storage: fileStorage(path) })
    r.data.a = { v: 1 }
    await sleep(20)
    const committed = r[diagnostics].logSize()
    assert.ok(committed >= 1, 'the live write committed')
    const walBefore = await readFile(path, 'utf8')
    r.destroy()
    r.data.b = { v: 2 } // late write on the torn-down node
    await sleep(20)
    assert.equal(r[diagnostics].logSize(), committed, 'the late write did NOT reach the log')
    assert.equal(await readFile(path, 'utf8'), walBefore, 'the late write did NOT reach the WAL')
  } finally {
    await rm(path, { force: true })
  }
})

test('a local overwrite of a higher-epoch winner commits at the WINNER epoch — not the lagging view epoch', async () => {
  // Regression: commitLocal stamped viewEpoch() unconditionally. A node whose committed view
  // lags the epoch of a winner it already HOLDS (restored from storage, or a missed
  // VIEW_COMMIT) then overwrote the key at the lower epoch — every peer holding the newer-epoch
  // winner sticky-fenced the record (B1 skip) while the writer kept it locally: silent
  // per-key divergence until the next write. A deliberate local overwrite is not a stale-view
  // straggler — it must dominate: epoch = max(view, winner), seq = merged clock + 1.
  const winner = { type: 'update' as const, key: ['k'], value: { v: 1 }, origin: 'REMOTE-ORIGIN', seq: 50, epoch: 7 }
  const [p1, p2] = [await ports.free(), await ports.free()]
  const A: any = await fero('epoch-dom', { host: '127.0.0.1', port: p1, ports: [p1, p2], wait: 200, storage: { load: () => [winner], append: () => {} } })
  const B: any = await fero('epoch-dom', { host: '127.0.0.1', port: p2, ports: [p1, p2], wait: 200 })
  try {
    // B acquires the restored epoch-7 winner via catch-up
    assert.ok(await until(() => B.data[value]?.k?.v === 1, 6000), 'B caught up to the restored winner')
    assert.ok(A.cluster.epoch < 7, `precondition: A's view epoch (${A.cluster.epoch}) lags the winner epoch (7)`)
    A.data.k = { v: 2 } // the deliberate overwrite — used to stamp the LAGGING epoch and fence at B forever
    assert.ok(await until(() => B.data[value]?.k?.v === 2, 6000), 'B applied the overwrite — NOT epoch-fenced (this diverged permanently before the fix)')
  } finally {
    A.destroy()
    B.destroy()
  }
})
