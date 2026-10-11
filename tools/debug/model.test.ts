//! Debug-model suite: the folds are validated against REAL captures from real seeded runs — never fixtures
// authored to match the fold (v2's sample-coverage lock validated only a hand-authored sample, so the live
// feed drifted 5-of-6 tokens dead; here the fixture IS a live capture by construction).

import { test } from 'node:test'
import assert from 'node:assert'
import { Sim } from '../../sim/exec.ts'
import { cluster, client, formed, writes } from '../../sim/harness.ts'
import { converged } from '../../sim/monitors.ts'
import { JK } from '../../kernel/journal.ts'
import { captureSim } from './capture.ts'
import { encodeVal, decodeVal, kindNames, stateAt, verifyReplay, routes, contested, summarize, topologyAt, verifyTopology, agreement } from './model.mjs'
import { scopedCut, scopedTenure, mixed, unscopedLeaver } from './fixtures.ts'
import { captureLive } from './capture.ts'
import { REC } from '../../kernel/env.ts'

//! one real chaotic trajectory shared by the suite: dup faults + a partition/heal window + racing writes
const chaoticCapture = () => {
  const sim = new Sim(1337)
  const nodes = cluster(sim, 3)
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      sim.fault(nodes[i].uuid, nodes[j].uuid, { delay: [1, 15], dupP: 0.3 })
  writes(sim, nodes, 50, 300)
  sim.at(60, () => sim.partition('n01', 'n03'))
  sim.at(200, () => sim.heal('n01', 'n03'))
  sim.run()
  assert.ok(formed(nodes) && converged(sim) === null, 'fixture trajectory must be healthy')
  return captureSim(sim)
}

test('value codec round-trips the JSON-hostile zoo (NaN, ±Infinity, -0, undefined, bytes, $-keys, nesting)', () => {
  const zoo = [NaN, Infinity, -Infinity, -0, undefined, null, new Uint8Array([1, 0, 255]),
    { $: 'user-key', n: NaN }, [1, undefined, { deep: new Uint8Array([7]) }], 'plain', 42]
  for (const v of zoo) {
    const round = decodeVal(JSON.parse(JSON.stringify(encodeVal(v))))
    if (typeof v === 'number' && Number.isNaN(v)) assert.ok(Number.isNaN(round))
    else assert.deepEqual(round, v)
  }
  assert.ok(Object.is(decodeVal(JSON.parse(JSON.stringify(encodeVal(-0)))), -0))
})

test('captures are self-describing: vocab IS the kernel JK const; kindNames inverts it completely', () => {
  const cap = chaoticCapture()
  assert.deepEqual(cap.vocab, JK)
  const names = kindNames(cap)
  for (const [name, code] of Object.entries(JK)) assert.equal(names[code as number], name)
})

//! THE replay-refold check (plan §3.1 graft, previously listed as pending): the model's LWW fold over the
// capture reproduces every node's exact end state — proving capture completeness and fold/kernel agreement.
test('verifyReplay: replaying journal+logs reproduces every node end state exactly', () => {
  const cap = chaoticCapture()
  for (const r of verifyReplay(cap)) assert.ok(r.ok, `${r.uuid}: ${r.reason}`)
})

test('stateAt is genuine time travel: empty at t=0, monotonically fills, equals end state at t=∞', () => {
  const cap = chaoticCapture()
  const node = cap.nodes[0]
  assert.equal(stateAt(cap, node.uuid, -1).size, 0)
  const mid = stateAt(cap, node.uuid, Math.floor(node.journal.length / 2)).size
  const end = stateAt(cap, node.uuid, Infinity).size
  assert.ok(mid > 0 && mid <= end)
  assert.equal(end, node.state.length)
})

test('routes: every local write has an origin row; statuses cover the whole cluster; healed writes show applied', () => {
  const cap = chaoticCapture()
  const rs = routes(cap)
  assert.ok(rs.size >= 45, `expected ≥45 routed writes, got ${rs.size}`) // ~50 scheduled minus LWW-only removes on absent keys
  for (const r of rs.values()) {
    assert.equal(Object.keys(r.nodes).length, 3, 'a route row exists for EVERY node — absence is information')
    const statuses = new Set(Object.values(r.nodes).map((s) => s.status))
    for (const s of statuses) assert.ok(['origin', 'applied', 'lww-lost', 'duplicate', 'never-arrived'].includes(s))
  }
  //! the trajectory converged, so nothing may have permanently never-arrived at quiescence
  for (const r of rs.values())
    assert.ok(Object.values(r.nodes).some((s) => s.status === 'origin'), `route ${r.origin}#${r.seq} lost its origin`)
})

test('contested surfaces real LWW elections with the fold-consistent winner', () => {
  const cap = chaoticCapture()
  const cs = contested(cap)
  assert.ok(cs.length > 0, 'a 50-write 20-key workload must contest some cells')
  for (const c of cs) {
    for (const cand of c.candidates.slice(1))
      assert.ok(
        c.winner.epoch > cand.epoch || c.winner.seq > cand.seq || (c.winner.seq === cand.seq && c.winner.origin > cand.origin),
        'winner must dominate every candidate under (epoch, seq, origin)',
      )
  }
})

test('contested is elections, not history: successive same-origin updates never read as contention', () => {
  //! regression — the fold once counted ANY multi-candidate cell as contested, so a single writer
  // updating its own key three times rendered as a "conflict" (the source of the debugger's false
  // contention wall). Contested must derive from lwwSkip: real rejected candidates only.
  const sim = new Sim(7)
  const nodes = cluster(sim, 2)
  sim.run()
  for (let i = 0; i < 3; i++)
    sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: i }] }, 1 + i * 10) // spaced: each replicates before the next — pure causal history
  sim.run()
  assert.equal(contested(captureSim(sim)).length, 0, 'a single-writer causal chain is history, not contention')
  //! and the same cell DOES contest once two origins race it concurrently
  sim.post('n01', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: 'a' }] }, 1)
  sim.post('n02', { kind: 'write', recs: [{ type: 0, key: ['solo'], value: 'b' }] }, 1)
  sim.run()
  const cs = contested(captureSim(sim))
  assert.equal(cs.length, 1, 'a genuine two-origin race must surface exactly this cell')
  assert.equal(converged(sim), null, 'and LWW still converges it')
})

test('summarize reports capture health honestly (convergence from hashes, truncation surfaced)', () => {
  const cap = chaoticCapture()
  const s = summarize(cap)
  assert.equal(s.kind, 'sim')
  assert.equal(s.seed, 1337)
  assert.equal(s.nodes, 3)
  assert.equal(s.converged, true)
  assert.deepEqual(s.truncated, [])
  assert.deepEqual(s.violations, [])
})

//! ── topology replay (links + streams under time travel) ──
type L = { id: number; uuid: string; dialed: boolean; admitted: boolean; synced: boolean | null; paused: boolean; queued: number | null; closing: boolean }
type W = { a: number; s: number; d: number | null; n: number }
type Topo = { links: Map<number, L>; streams: Map<string, W> }

test('topologyAt is genuine time travel for links and streams: nothing at t0, the captured end tables at ∞, a dial-race loser CLOSING in between', () => {
  const cap = chaoticCapture()
  const K = cap.vocab
  for (const n of cap.nodes) {
    const t0 = topologyAt(cap, n.uuid, 0) as Topo
    assert.equal(t0.links.size, 0, 'no line is open at t0 — the journal starts with start + dials')
    assert.equal(t0.streams.size, 0, 'no stream before the first record')
    const end = topologyAt(cap, n.uuid, Infinity) as Topo
    assert.deepEqual([...end.links.keys()].sort((a, b) => a - b), n.links.map((l) => l.id).sort((a, b) => a - b), 'the captured link ids, exactly')
    for (const l of n.links) {
      const r = end.links.get(l.id)!
      assert.deepEqual(
        { uuid: r.uuid, dialed: r.dialed, admitted: r.admitted, synced: r.synced, paused: r.paused, queued: r.queued, closing: r.closing },
        { uuid: l.uuid, dialed: l.dialed, admitted: l.admitted, synced: l.synced, paused: l.paused, queued: l.queued, closing: false },
        `link #${l.id} replays field for field`)
    }
    assert.deepEqual([...end.streams.keys()].sort(), Object.keys(n.streams).sort(), 'the captured origins, exactly')
    for (const [o, w] of Object.entries(n.streams)) {
      const r = end.streams.get(o)!
      assert.deepEqual({ a: r.a, s: r.s, d: r.d }, w, `stream ${o}: the watermark ladder replays (durable is PROVABLY 0 on a never-persisting node)`)
    }
  }
  assert.ok((verifyTopology(cap) as { ok: boolean }[]).every((r) => r.ok), 'the drift guard passes on the chaotic fixture')
  //! the dial race: at the dupLink row the loser is CLOSING and still in the table (the kernel deletes only
  // on the linkDown echo); by the end it is gone
  let races = 0
  for (const n of cap.nodes)
    for (const e of n.journal) {
      if (e.kind !== K.dupLink) continue
      const at = (topologyAt(cap, n.uuid, e.t) as Topo).links.get(e.a as number)
      assert.ok(at && at.closing, `${n.uuid}: the loser #${e.a} is closing at its dupLink row`)
      assert.ok(!(topologyAt(cap, n.uuid, Infinity) as Topo).links.get(e.a as number), 'and gone by the end')
      races++
    }
  assert.ok(races > 0, 'the fixture holds at least one dial race')
  //! links pop into existence: some intermediate step shows a partly-formed mesh
  const n0 = cap.nodes[0]
  const admittedAt = (t: number) => [...(topologyAt(cap, n0.uuid, t) as Topo).links.values()].filter((l) => l.admitted).length
  const samples = Array.from({ length: 40 }, (_, i) => admittedAt(Math.floor((i / 40) * n0.journal.length)))
  assert.ok(samples.some((c) => c > 0 && c < n0.links.length), `an intermediate step is mid-formation (${samples.join(',')})`)
})

test('paused links: queued is an UNKNOWN (null) the replay never claims — verifyTopology skips it; drain restores the fact', () => {
  const sim = new Sim(3)
  const nodes = cluster(sim, 2)
  sim.run()
  assert.ok(formed(nodes))
  const link = nodes[0].links.values().next().value!
  sim.post('n01', { kind: 'pause', link: link.id })
  sim.run()
  for (let i = 0; i < 5; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] }, i)
  sim.run()
  assert.ok(link.paused && link.queued.length > 0, 'the real link parked frames while paused')
  const paused = captureLive([...sim.nodes.values()])
  const rp = (topologyAt(paused, 'n01', Infinity) as Topo).links.get(link.id)!
  assert.equal(rp.paused, true)
  assert.equal(rp.queued, null, 'the parked depth is not a diary fact — null, never a guess')
  assert.ok((verifyTopology(paused) as { ok: boolean; reason?: string }[]).every((r) => r.ok), 'an unknown is never compared — the guard still passes')
  sim.post('n01', { kind: 'drain', link: link.id })
  sim.run()
  const drained = captureSim(sim)
  const rd = (topologyAt(drained, 'n01', Infinity) as Topo).links.get(link.id)!
  assert.deepEqual({ paused: rd.paused, queued: rd.queued, synced: rd.synced }, { paused: false, queued: 0, synced: true })
  assert.ok((verifyTopology(drained) as { ok: boolean }[]).every((r) => r.ok))
})

test('durable nodes: the durable mark is claimed only where provable — persisted ⇒ unknown (null), skipped by the guard; the replay still verifies', () => {
  const sim = new Sim(5)
  const nodes = cluster(sim, 2, { durable: true })
  writes(sim, nodes, 10, 100)
  sim.run()
  const cap = captureSim(sim)
  const K = cap.vocab
  for (const n of cap.nodes) {
    assert.ok(n.journal.some((e) => e.kind === K.persisted), 'the fixture persisted')
    const end = topologyAt(cap, n.uuid, Infinity) as Topo
    for (const [o, w] of end.streams) {
      assert.equal(w.d, null, `${n.uuid}/${o}: durable is unknown once anything reached disk (batches carry no origin)`)
      assert.deepEqual({ a: w.a, s: w.s }, { a: n.streams[o].a, s: n.streams[o].s })
    }
  }
  assert.ok((verifyTopology(cap) as { ok: boolean; reason?: string }[]).every((r) => r.ok), JSON.stringify(verifyTopology(cap)))
})

test('verifyTopology says why a replay is refused: a truncated ring, and a capture whose end table the journal cannot reproduce', () => {
  const sim = new Sim(11)
  const small = ['s1', 's2'].map((uuid, i, all) => sim.add({ uuid, listen: `sim:${uuid}`, hosts: all.filter((_, j) => j !== i).map((u) => `sim:${u}`), redialMs: 20, journalCap: 8 }))
  for (const n of small) sim.post(n.uuid, { kind: 'start' })
  writes(sim, small, 6, 40); sim.run()
  const truncated = captureLive(small)
  for (const r of verifyTopology(truncated) as { ok: boolean; reason: string }[]) {
    assert.equal(r.ok, false)
    assert.match(r.reason, /^journal truncated \(\d+ dropped\)$/)
  }
  //! a capture whose end table disagrees with its journal (here: a link the journal never opened) is refused
  // with the specific field — the viewer keeps that node's end tables, labelled with this reason
  const cap = chaoticCapture()
  const n = cap.nodes[0]
  const forged = { ...cap, nodes: cap.nodes.map((x) => (x === n ? { ...x, links: [...x.links, { ...x.links[0], id: 999999 }] } : x)) }
  const [r] = verifyTopology(forged) as { ok: boolean; reason: string }[]
  assert.equal(r.ok, false)
  assert.match(r.reason, /^links size \d+ vs \d+$/)
})

test('clients: the single-feeder rule — only the primary syncs; when it drops, the next admitted survivor is elected and syncs on its digest', () => {
  const sim = new Sim(9)
  const servers = cluster(sim, 3)
  client(sim, 'c1', servers)
  sim.run()
  writes(sim, servers, 6, 100)
  sim.run()
  const cap = captureSim(sim)
  const c = cap.nodes.find((x) => x.uuid === 'c1')!
  assert.equal(c.client, true, 'the capture carries the role (the additive diagNode field)')
  const end = topologyAt(cap, 'c1', Infinity) as Topo
  assert.equal(end.links.size, 3, 'a spoke holds a line to every server')
  const synced = [...end.links.values()].filter((l) => l.synced)
  assert.equal(synced.length, 1, 'exactly ONE feeder is synced — the others digest nothing (kernel: the DIGEST handler answers only the primary)')
  assert.deepEqual(c.links.filter((l) => l.synced).map((l) => l.id), [synced[0].id], 'and it is the one the kernel holds synced')
  assert.ok((verifyTopology(cap) as { ok: boolean; reason?: string }[]).every((r) => r.ok), JSON.stringify(verifyTopology(cap)))
  //! failover: cut the primary's peer — the kernel elects the next admitted survivor and digests it
  const primary = synced[0]
  sim.partition('c1', primary.uuid)
  sim.run({ until: sim.now + 500 })
  const cap2 = captureSim(sim)
  const end2 = topologyAt(cap2, 'c1', Infinity) as Topo
  assert.ok(!end2.links.has(primary.id), 'the old primary is gone')
  const synced2 = [...end2.links.values()].filter((l) => l.synced)
  assert.equal(synced2.length, 1, 'one feeder again')
  assert.notEqual(synced2[0].id, primary.id)
  const c2 = cap2.nodes.find((x) => x.uuid === 'c1')!
  assert.deepEqual(c2.links.filter((l) => l.synced).map((l) => l.id), [synced2[0].id], 'the replay elected the same survivor the kernel did')
  assert.ok((verifyTopology(cap2) as { ok: boolean; reason?: string }[]).every((r) => r.ok), JSON.stringify(verifyTopology(cap2)))
})

test('a digest on a PAUSED link never syncs it (kernel marks debt and returns before synced=true): an overflowed, still-paused link stays unsynced through the digest', () => {
  const sim = new Sim(4)
  //! heartbeats: the LOWER uuid (n01) originates the PING + r=1 digest floor, and skips its own paused links —
  // so the paused side must be n02: n01's floor digest keeps arriving on n02's paused link
  const nodes = cluster(sim, 2, { heartbeatMs: 50 })
  sim.run({ until: 300 })
  assert.ok(formed(nodes))
  const link = nodes[1].links.values().next().value!
  assert.equal(link.synced, true, 'synced before the pause')
  sim.post('n02', { kind: 'pause', link: link.id })
  sim.run({ until: sim.now + 10 })
  for (let i = 0; i < 300; i++) sim.post('n02', { kind: 'write', recs: [{ type: REC.update, key: [`k${i}`], value: i }] }, i * 0.1)
  sim.run({ until: sim.now + 400 })
  const cap = captureLive([...sim.nodes.values()])
  const K = cap.vocab
  const j = cap.nodes.find((n) => n.uuid === 'n02')!.journal
  const iDrop = j.findIndex((e) => e.kind === K.dropOldest && e.a === link.id)
  assert.ok(iDrop >= 0, 'the queue overflowed (dropOldest) while paused — synced fell')
  assert.ok(j.slice(iDrop).some((e) => e.kind === K.digestIn && e.a === link.id), 'a digest ARRIVED on the paused link after the overflow')
  assert.equal(link.synced, false, 'the kernel left it unsynced (paused: debt marked, no sync)')
  const r = (topologyAt(cap, 'n02', Infinity) as Topo).links.get(link.id)!
  assert.deepEqual({ paused: r.paused, synced: r.synced, queued: r.queued }, { paused: true, synced: false, queued: null })
  assert.ok((verifyTopology(cap) as { ok: boolean; reason?: string }[]).every((x) => x.ok), JSON.stringify(verifyTopology(cap)))
})

test('walTaint (a lying disk condemned at replay) resets the fold: streams AND state are empty at that row, re-taught after — the ∞ guard alone cannot see this', () => {
  const sim = new Sim(200)
  const nodes = cluster(sim, 3, { durable: true, heartbeatMs: 50 })
  sim.run({ until: 300 })
  writes(sim, nodes, 12, 200)
  sim.run({ until: 800 })
  const store = sim.stores.get('n03')!
  const resolved = store.wal.map((r, i) => (r.resolved ? i : -1)).filter((i) => i >= 0)
  assert.ok(resolved.length >= 3, `n03 has an interior resolved row to poison (${resolved.length})`)
  store.wal[resolved[1]].lied = true   // an fsync lie: the row vanishes at restart, leaving an INTERIOR hole in the chain
  sim.restart('n03')
  sim.run({ until: sim.now + 1500 })
  const cap = captureSim(sim)
  const K = cap.vocab
  const n = cap.nodes.find((x) => x.uuid === 'n03')!
  const taint = n.journal.find((e) => e.kind === K.walTaint)
  assert.ok(taint, 'the restart condemned the lying disk (walTaint)')
  assert.ok(n.journal.some((e) => e.kind === K.applyInbound && e.t < taint!.t), 'rows replayed BEFORE the hole — the fold had lanes and state to reset')
  assert.equal((topologyAt(cap, 'n03', taint!.t) as Topo).streams.size, 0, 'every lane is gone at the walTaint row')
  assert.equal((stateAt(cap, 'n03', taint!.t) as Map<string, unknown>).size, 0, 'and so is the state')
  assert.ok((topologyAt(cap, 'n03', Infinity) as Topo).streams.size > 0, 're-taught by anti-entropy afterwards')
  assert.ok((verifyTopology(cap) as { ok: boolean; reason?: string }[]).every((r) => r.ok), JSON.stringify(verifyTopology(cap)))
  assert.ok((verifyReplay(cap) as { ok: boolean; reason?: string }[]).every((r) => r.ok), JSON.stringify(verifyReplay(cap)))
})

test("a reborn node's own writes join its CURRENT lane (uuid~inc): the replay refolds, and each write is one route — not a phantom pair (ISSUES I-1)", () => {
  //! a durable pair; n01 is killed and restored from its WAL, then writes again — its new life stamps under n01~2
  const sim = new Sim(21); const pair = cluster(sim, 2, { durable: true }); writes(sim, pair, 6, 100); sim.run()
  sim.restart('n01'); sim.run()
  for (let i = 0; i < 3; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`after${i}`], value: i }] }, i * 5)
  sim.run()
  const cap = captureSim(sim)
  const n01 = cap.nodes.find((n) => n.uuid === 'n01')!
  assert.ok('n01~2' in n01.logs, 'the new life stamps under n01~2 — the fixture is what it claims')
  for (const r of verifyReplay(cap)) assert.ok(r.ok, `${r.uuid}: ${r.reason}`)
  assert.equal(stateAt(cap, 'n01', Infinity).size, n01.state.length, 'time travel on the reborn node ends where its state is')
  const rs = routes(cap)
  const after = [...rs.values()].filter((r) => r.origin === 'n01~2')
  assert.equal(after.length, 3, 'three post-restart writes: one route each, under the new lane')
  for (const r of after) {
    assert.equal(r.nodes.n01.status, 'origin', `${r.origin}#${r.seq} was born at n01`)
    assert.equal(r.nodes.n02.status, 'applied', `${r.origin}#${r.seq} was applied at n02`)
    assert.ok(r.partition != null, 'the writeLocal row names its partition')
    assert.ok(!rs.has(`n01#${r.seq}`), `no phantom bare-lane route n01#${r.seq}`)
  }
})

//! ── scoped replication (ISSUES I-3) — the capture carries each origin's holder sets; routes() says not-a-holder ──
// 4 members, replicas: 2, 8 writes after the view is armed: every write lands on exactly its 2 holders, so the
// other 2 members never get it — by design. Before the capture carried holders, routes() painted 16 of the 32
// stops never-arrived (the reported false alarm).
const scopedCapture = () => {
  const sim = new Sim(11)
  const nodes = cluster(sim, 4, { heartbeatMs: 50, replicas: 2 })
  sim.run({ until: 1500 })
  assert.ok(formed(nodes) && nodes.every((n) => n.armed), 'formed and armed — the fixture is what it claims')
  writes(sim, nodes, 8, 200)
  sim.run({ until: 4000 })
  assert.deepEqual(sim.violations, [])
  return { cap: captureSim(sim), nodes }
}

type Route = { origin: string; seq: number; partition: string | null; nodes: Record<string, { status: string; t: number | null }> }

test('scoped captures: a member outside a write\'s holder set is not-a-holder, never never-arrived (ISSUES I-3)', () => {
  const { cap, nodes } = scopedCapture()
  const ring = nodes[0].writes.ring
  for (const n of cap.nodes) assert.equal(n.replicas, 2, `${n.uuid} carries its replicas`)
  let seen = 0
  for (const r of (routes(cap) as Map<string, Route>).values()) {
    assert.ok(r.partition != null, 'every route here was stamped after arming')
    const holders = new Set(ring.holders(r.partition!, 2))
    //! the capture's holder list is the ring's own answer, carried — never recomputed by the page
    const origin = cap.nodes.find((n) => n.uuid === r.origin)!
    assert.deepEqual(origin.holders![r.partition!], [...ring.holders(r.partition!, 2)])
    for (const n of cap.nodes) {
      const st = r.nodes[n.uuid].status
      if (holders.has(n.uuid)) assert.ok(st === 'origin' || st === 'applied', `holder ${n.uuid} of ${r.origin}#${r.seq}: ${st}`)
      else { assert.equal(st, 'not-a-holder', `non-holder ${n.uuid} of ${r.origin}#${r.seq}`); seen++ }
    }
  }
  assert.ok(seen >= 16, `every route has two quiet non-holders (${seen})`)
  //! a capture WITHOUT holders (an older bridge) keeps today's rule: absent is never-arrived
  const bare = { ...cap, nodes: cap.nodes.map(({ holders: _h, ...n }) => n) }
  const statuses = [...(routes(bare) as Map<string, Route>).values()].flatMap((r) => Object.values(r.nodes).map((s) => s.status))
  assert.ok(!statuses.includes('not-a-holder'), 'no holder facts, no not-a-holder claim')
  assert.equal(statuses.filter((s) => s === 'never-arrived').length, seen)
})

//! the two harder scoped cases (the wave-2 review of I-3): writes stamped BEFORE the view arms, and a 5th member
// that joins later. (1) A writer may stamp a row before the view arms and then hand it off: its own log no longer
// names that row, but its writeLocal rows do, so the capture still carries the row's holders. (2) A new holder
// copies a moved row whole (journal acquire) — no applyInbound per write — so its stop is `acquired`, at the
// acquire row, with the teacher. Before each fix those stops were painted never-arrived.
let moved: { cap: ReturnType<typeof captureSim>; ring: ReturnType<typeof cluster>[number]['writes']['ring'] } | null = null
const movedCapture = () => {
  if (moved) return moved
  const sim = new Sim(11)
  const nodes = cluster(sim, 4, { heartbeatMs: 50, replicas: 2 })
  writes(sim, nodes, 6, 100)
  sim.run({ until: 1500 })
  writes(sim, nodes, 8, 200)
  sim.run({ until: 4000 })
  sim.add({ uuid: 'n05', listen: 'sim:n05', hosts: nodes.map((n) => n.listen), heartbeatMs: 50, replicas: 2, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n05', { kind: 'start' })
  sim.run({ until: 12000 })
  assert.deepEqual(sim.violations, [])
  assert.ok([...sim.nodes.values()].every((n) => n.epoch === 2), 'the join view committed everywhere — the fixture is what it claims')
  return (moved = { cap: captureSim(sim), ring: nodes[0].writes.ring })
}

test('scoped captures: a write stamped before the view armed, to a row its writer then handed off, still carries the row\'s holders (ISSUES I-3)', () => {
  const { cap, ring } = movedCapture()
  let shed = 0
  for (const r of (routes(cap) as Map<string, Route>).values()) {
    const origin = cap.nodes.find((n) => n.uuid === r.origin)!
    assert.ok(r.partition != null)
    if (!(origin.logs[origin.uuid] || []).some((x: { k: string[] }) => x.k[0] === r.partition)) shed++
    //! the holder fact is there even when the origin's own log no longer holds the row
    assert.deepEqual(origin.holders![r.partition!], [...ring.holders(r.partition!, 2)], `${r.origin}#${r.seq} carries the ring's holders for ${r.partition}`)
    for (const n of cap.nodes)
      if (!origin.holders![r.partition!].includes(n.uuid) && r.nodes[n.uuid].status !== 'origin' && r.nodes[n.uuid].status !== 'applied')
        assert.equal(r.nodes[n.uuid].status, 'not-a-holder', `non-holder ${n.uuid} of ${r.origin}#${r.seq} (${r.partition})`)
  }
  assert.ok(shed > 0, `some route's row left its writer's log — the fixture is what it claims (${shed})`)
})

test('scoped captures: a write a new holder copied in with the whole row (journal acquire) is `acquired`, at that row, from its teacher — never never-arrived (ISSUES I-3)', () => {
  const { cap } = movedCapture()
  const K = cap.vocab
  let handoff = 0
  for (const r of (routes(cap) as Map<string, Route>).values()) {
    const origin = cap.nodes.find((n) => n.uuid === r.origin)!
    for (const n of cap.nodes) {
      const s = r.nodes[n.uuid] as { status: string; t: number | null; from?: string }
      assert.notEqual(s.status, 'never-arrived', `${n.uuid} of ${r.origin}#${r.seq} (${r.partition}) is not lost`)
      if (s.status !== 'acquired') continue
      //! acquired = the record book holds it AND the node journaled an acquire of that row, at that row
      handoff++
      assert.ok((n.logs[r.origin] || []).some((x: { seq: number }) => x.seq === r.seq), `${n.uuid} holds ${r.origin}#${r.seq}`)
      const row = n.journal.find((e) => e.t === s.t)!
      assert.equal(row.kind, K.acquire); assert.equal(String(row.a), r.partition); assert.equal(s.from, row.c)
      assert.ok(origin.holders![r.partition!].includes(n.uuid), 'a node that copied the row in is one of its holders')
    }
  }
  assert.ok(handoff > 0, `some write came in a hand-off — the fixture is what it claims (${handoff})`)
  //! one fact alone is not enough: without the acquire rows a held record keeps today's rule
  const noAcq = { ...cap, nodes: cap.nodes.map((n) => ({ ...n, journal: n.journal.filter((e) => e.kind !== K.acquire) })) }
  const st = [...(routes(noAcq) as Map<string, Route>).values()].flatMap((r) => Object.values(r.nodes).map((x) => x.status))
  assert.ok(!st.includes('acquired'), 'no acquire row, no acquired claim')
})

test('the replay folds hand-offs: shed drops a row\'s cells, acquire copies a row in — every node of a scoped capture with a join refolds to its captured state', () => {
  const { cap } = movedCapture()
  const K = cap.vocab
  const has = (k: number) => cap.nodes.filter((n) => n.journal.some((e) => e.kind === k)).length
  assert.ok(has(K.shed) > 0 && has(K.acquire) > 0, 'rows were shed and acquired — the fixture is what it claims')
  for (const r of verifyReplay(cap) as { uuid: string; ok: boolean; reason?: string }[]) assert.ok(r.ok, `${r.uuid}: ${r.reason}`)
})

//! the rewind steps around a hand-off (end-state refolds cannot see these: a shed row's records leave the book
// with it, and re-folding a held record is a no-op). A 5th member joins, then leaves cleanly, so rows move to it
// and back: an old holder sheds a row and later acquires it again. Two kernel laws, checked at the step itself:
// right after shed(p) the node holds no cell of p (scope.ts #shed drops them all), and right after acquire(p) it
// holds no record that later arrives by its own applyInbound row (a taught record's later copy is a dupDrop).
test('the replay at a hand-off step: no cell of a row just shed, and no record an acquire did not teach', () => {
  const sim = new Sim(11)
  const nodes = cluster(sim, 4, { heartbeatMs: 50, replicas: 2 })
  sim.run({ until: 1500 }); writes(sim, nodes, 10, 200); sim.run({ until: 4000 })
  const n5 = sim.add({ uuid: 'n05', listen: 'sim:n05', hosts: nodes.map((n) => n.listen), heartbeatMs: 50, replicas: 2, redialMs: 20, journalCap: 1 << 16 })
  sim.post('n05', { kind: 'start' }); sim.run({ until: 9000 })
  writes(sim, [...nodes, n5], 6, 150); sim.run({ until: 10500 })
  sim.post('n05', { kind: 'leave' }); sim.run({ until: 16000 })
  //! writes after the rows came back: live arrivals after an acquire. 40 over 20 keys (was 8): DESIGN-SCALE stage 2
  // moved every scoped trajectory, and on this seed 8 random writes no longer hit a re-acquired row at the node that
  // re-acquired it (the fixture's `liveAfter` read 0); 40 cover every key several times over.
  writes(sim, nodes, 40, 300); sim.run({ until: 20000 })
  assert.deepEqual(sim.violations, [])
  const cap = captureSim(sim)
  const K = cap.vocab
  for (const r of verifyReplay(cap) as { uuid: string; ok: boolean; reason?: string }[]) assert.ok(r.ok, `${r.uuid}: ${r.reason}`)
  let backAgain = 0, liveAfter = 0
  for (const n of cap.nodes) {
    const shedSeen = new Set<string>()
    const rows = new Map<string, number[]>()
    for (const e of n.journal) if (e.kind === K.applyInbound) { const k = e.a + '#' + e.b; rows.set(k, [...(rows.get(k) || []), e.t]) }
    for (const e of n.journal) {
      const p = String(e.a)
      if (e.kind === K.shed) {
        shedSeen.add(p)
        for (const k of (stateAt(cap, n.uuid, e.t) as Map<string, unknown>).keys())
          assert.notEqual(JSON.parse(k)[0], p, `${n.uuid} still holds ${k} right after shedding ${p}`)
      } else if (e.kind === K.acquire) {
        if (shedSeen.has(p)) backAgain++
        for (const [o, entries] of Object.entries(n.logs) as [string, { k: string[]; seq: number }[]][])
          for (const x of entries) if (x.k[0] === p && (rows.get(o + '#' + x.seq) || []).some((r) => r > e.t)) liveAfter++
        for (const [k, c] of stateAt(cap, n.uuid, e.t) as Map<string, { origin: string; seq: number }>) {
          const at = rows.get(c.origin + '#' + c.seq) || []
          assert.ok(!at.length || at.some((x) => x <= e.t), `${n.uuid} holds ${k} (${c.origin}#${c.seq}) at acquire(${p}), but it only arrived later`)
        }
      }
    }
  }
  assert.ok(backAgain > 0, `a node shed a row and acquired it back — the fixture is what it claims (${backAgain})`)
  assert.ok(liveAfter > 0, `a held record of an acquired row arrived live after the acquire — the fixture is what it claims (${liveAfter})`)
})

const partOfKey = (ck: string) => { const p = JSON.parse(ck); return String(Array.isArray(p) ? p[0] : p) }
type Agreement = { converged: boolean | null; off: string[]; groups: { name: string | null; nodes: string[]; scoped: boolean; converged: boolean; rows?: Map<string, string[]>; bad?: string[] }[] }
type Stop = { status: string; t: number | null }
type Rt = { origin: string; seq: number; partition: string | null; group: string | null; nodes: Record<string, Stop> }

test('a scoped capture is judged per row among its holders: converged when every row\'s holders agree, and only the lagging holder is off (wave 5e)', () => {
  const { cut, healed, owner, lagging, row } = scopedCut()
  //! whole-node fingerprints differ by design here (each member holds only its rows) — the old rule painted every node
  const hashes = new Set(healed.nodes.map((n) => n.stateHash))
  assert.ok(hashes.size > 1, 'the healed members still hold different rows: one fingerprint per node cannot judge them')
  const h = agreement(healed) as Agreement
  assert.equal(h.converged, true, 'every row\'s holders agree')
  assert.deepEqual(h.off, [], 'nobody is off')
  assert.equal(summarize(healed).converged, true, 'the header says converged')
  assert.equal(h.groups[0].scoped, true)
  //! the cut: the row's three holders are judged, two agree, the lagging one is the odd one out — nobody else
  const c = agreement(cut) as Agreement
  assert.equal(c.converged, false)
  assert.deepEqual(c.groups[0].bad, [row], 'exactly the row the holders disagree on')
  assert.deepEqual(c.off, [lagging], 'only the lagging holder is off — a strict majority of the row\'s holders agrees')
  assert.ok(c.groups[0].rows!.get(row)!.includes(owner) && c.groups[0].rows!.get(row)!.includes(lagging), 'the row is judged among its holders')
  assert.equal(summarize(cut).converged, false)
})

test('a plain scoped run agrees row by row, though its fingerprints differ by design (the header said differs on every node before wave 5e)', () => {
  const cap = scopedCapture().cap
  const a = agreement(cap) as Agreement
  assert.ok(new Set(cap.nodes.map((n) => n.stateHash)).size > 1, 'its fingerprints differ by design')
  assert.equal(a.converged, true); assert.deepEqual(a.off, [])
})

test('clients and members that left are judged right: a client against its feeder\'s rows, a leaver and a voted-out member only for rows they held while in (wave 5e)', () => {
  const { cap, missed } = scopedTenure()
  const rs = [...(routes(cap) as Map<string, Rt>).values()]
  const by = (u: string) => cap.nodes.find((n) => n.uuid === u)!
  const stops = (u: string) => rs.filter((r) => r.nodes[u]).map((r) => ({ r, s: r.nodes[u] }))
  //! the client: quiet exactly for the rows its feeder does not hold; nothing it should have is missing here
  const feeder = by(by('zc1').feeder as string)
  const zq = stops('zc1').filter((x) => x.s.status === 'not-a-holder')
  assert.ok(zq.length > 0, 'the client was meant to miss some writes — the fixture is what it claims')
  for (const { r } of zq) assert.ok(!feeder.held!.includes(r.partition!), `${r.origin}#${r.seq}: quiet only for a row its feeder does not hold`)
  for (const { r, s } of stops('zc1')) if (feeder.held!.includes(r.partition!)) assert.notEqual(s.status, 'not-a-holder', 'a row its feeder holds is one it is meant to have')
  //! the leaver and the voted-out member: no red stop for a row they never held, and they were judged somewhere
  //! the leaver missed exactly one write it was meant to get — a row it held, stamped while it was in — and that one is red
  assert.deepEqual(stops('n04').filter((x) => x.s.status === 'never-arrived').map((x) => `${x.r.origin}#${x.r.seq}`), [missed], 'n04: the one real miss, and nothing else')
  assert.deepEqual(stops('n05').filter((x) => x.s.status === 'never-arrived').map((x) => `${x.r.origin}#${x.r.seq}`), [], 'n05: nothing it held was missed while it was in')
  for (const u of ['n04', 'n05']) {
    assert.ok(stops(u).some((x) => x.s.status === 'not-a-holder'), `${u}: the writes after it went are quiet`)
    assert.ok(stops(u).some((x) => x.s.status === 'applied' || x.s.status === 'origin'), `${u}: it took writes while it was in`)
  }
  //! every write stamped after the leave view is quiet at the leaver; a write it held the row of, stamped while it was in, is not
  const n04 = by('n04')
  const leftAt = n04.journal.filter((e) => e.kind === cap.vocab.viewInstall).at(-1)!.a as number
  const epochOf = (r: Rt) => (cap.nodes.flatMap((n) => n.logs[r.origin] || []).find((x) => x.seq === r.seq) || { epoch: null }).epoch
  for (const { r, s } of stops('n04')) if (epochOf(r) != null && (epochOf(r) as number) >= leftAt) assert.equal(s.status, 'not-a-holder', `${r.origin}#${r.seq} came after n04 left`)
  //! the copies: a member that left keeps an old copy — never compared, never off. The three that stay agree. The client is
  // compared against its feeder's rows only; here it misses a row its feeder took over in a hand-off (a real kernel gap,
  // STATUS) — and the two folds say the same thing: off on exactly those rows, its stops for them never-arrived
  const a = agreement(cap) as Agreement
  assert.ok(!a.off.includes('n05') && !a.off.includes('n04'), 'a member that left is not compared')
  //! the client IS compared, row by row, on exactly the rows its feeder holds (the assertions below pass vacuously
  // when it is never compared, so pin the participants themselves)
  const rows = a.groups[0].rows!
  for (const p of feeder.held!) assert.ok((rows.get(p) || []).includes('zc1'), `${p}: the client is judged on a row its feeder holds`)
  for (const [p, us] of rows) if (!feeder.held!.includes(p)) assert.ok(!us.includes('zc1'), `${p}: and on no other row`)
  //! a value the client got wrong on such a row makes it the odd one out (a copy of the real capture, one cell changed)
  const p0 = feeder.held!.find((p) => by('zc1').state.some(([k]) => partOfKey(k) === p) && rows.get(p)!.length >= 3 && !(a.groups[0].bad ?? []).includes(p))!
  assert.ok(p0, 'a row the client and at least two members hold and agree on — the fixture is what it claims')
  const planted = structuredClone(cap)
  const zc = planted.nodes.find((n) => n.uuid === 'zc1')!
  const ci = zc.state.findIndex(([k]) => partOfKey(k) === p0)
  zc.state[ci] = [zc.state[ci][0], 'planted']
  const pa = agreement(planted) as Agreement
  assert.ok(pa.off.includes('zc1') && pa.groups[0].bad!.includes(p0), 'the client disagrees with its row\'s holders: it is off')
  assert.ok(a.off.every((u) => u === 'zc1'), 'the members of the newest view agree with each other')
  for (const p of a.groups[0].bad ?? []) {
    assert.ok(feeder.held!.includes(p), `${p}: a row the client is off on is one its feeder holds`)
    assert.ok(rs.some((r) => r.partition === p && r.nodes.zc1?.status === 'never-arrived'), `${p}: and routes() names the write it lacks`)
  }
})

test('a capture of two resources is judged per resource: each agrees inside itself, and a write\'s stops are its own resource\'s nodes (wave 5e)', () => {
  const cap = mixed()
  const a = agreement(cap) as Agreement
  assert.deepEqual(a.groups.map((g) => [g.name, g.nodes]), [['shop', ['s1', 's2']], ['#directory', ['d1']]])
  assert.equal(a.converged, true, 'shop agrees with shop; the directory alone agrees with itself')
  assert.deepEqual(a.off, [])
  assert.equal(summarize(cap).converged, true)
  for (const r of (routes(cap) as Map<string, Rt>).values()) {
    const g = r.origin === 'd1' ? '#directory' : 'shop'
    assert.equal(r.group, g, `${r.origin}#${r.seq} belongs to ${g}`)
    assert.deepEqual(Object.keys(r.nodes).sort(), g === 'shop' ? ['s1', 's2'] : ['d1'], 'only its own resource\'s nodes are stops')
    assert.ok(!Object.values(r.nodes).some((s) => s.status === 'never-arrived'))
  }
})

test('an unscoped member that left is judged by its tenure everywhere: not compared, quiet for writes made after it left, and the write it took while in still counts (wave 5e)', () => {
  const { cap, before, after } = unscopedLeaver()
  const a = agreement(cap) as Agreement & { groups: { judged?: string[] }[] }
  assert.equal(a.groups[0].scoped, false)
  assert.deepEqual(a.groups[0].judged, ['n01', 'n02', 'n03'], 'the three that stay are compared; the leaver keeps an old copy by design')
  assert.equal(a.converged, true); assert.deepEqual(a.off, [])
  const rs = routes(cap) as Map<string, Rt>
  assert.equal(rs.get(before)!.nodes.n04.status, 'applied', 'the write made while n04 was in reached it')
  //! the writes made after it left were never meant for it: quiet, never a missing stop (the header must not say
  // converged above writes that still wait for the leaver)
  for (const id of after) assert.equal(rs.get(id)!.nodes.n04.status, 'not-a-holder', `${id} came after n04 left`)
  for (const r of rs.values()) assert.notEqual(r.nodes.n04?.status, 'never-arrived', `${r.origin}#${r.seq}: nothing n04 was meant to get is missing`)
})
