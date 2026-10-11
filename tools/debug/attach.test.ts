//! ── tools/debug/attach.test — the DIAG bridge end-to-end over REAL sockets ───────────────────
// Tier-3: two DIAG-enabled Runtimes + a dead address + a wrong-token target → the assembled capture
// carries exactly the answering nodes, every failure as a typed absent row, and NOTHING invented.
// The parity pin is the load-bearing one: a slice pulled over the wire must deepEqual the in-process
// captureNode of the same node (one fold, two consumers — DESIGN-M7 §1).

//! the battery pins first: one case below composes a real fero() (directory off, config layer off)
import '../../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../../shell/runtime.ts'
import { fero } from '../../api/index.ts'
import { AttachPool, DiagClient, pullNode, type Puller } from './attach.ts'
import { onDiagQ } from '../../kernel/diag.ts'
import { Framer, VERB } from '../../kernel/codec.ts'
import type { Node } from '../../kernel/node.ts'
import { Sim } from '../../sim/exec.ts'
import { cluster, writes } from '../../sim/harness.ts'
import { captureNode } from './capture.ts'
import { verifyReplay, summarize, routes, verifyTopology } from './model.mjs'
import { REC } from '../../kernel/env.ts'
import { JK } from '../../kernel/journal.ts'
import { ports, until } from '#utils'

const TOKEN = 'attach-token-1234'

const spin = async (n: number) => {
  const ps = await Promise.all(Array.from({ length: n }, () => ports.free()))
  const addrs = ps.map((p) => `127.0.0.1:${p}`)
  const rts = addrs.map((a, i) => new Runtime({
    uuid: `n${i + 1}`, name: 'r', listen: a, hosts: addrs.filter((_, j) => j !== i),
    redialMs: 100, heartbeatMs: 500, journalCap: 1 << 14,
    diag: { allow: { ops: TOKEN } },
  }))
  for (const r of rts) await r.start()
  return { rts, addrs, stop: async () => { for (const r of rts) await r.destroy() } }
}

test('parity: a slice pulled over the DIAG wire deepEquals the in-process captureNode', async () => {
  const { rts, addrs, stop } = await spin(2)
  const c = new DiagClient(addrs[0], TOKEN)
  try {
    for (let i = 0; i < 12; i++)
      rts[0].write([{ type: REC.update, key: [`k${i % 4}`], value: { i, s: `v${i}-é`, bytes: new Uint8Array([i]) } }])
    rts[0].write([{ type: REC.remove, key: ['k1'] }])
    await until(() => rts[1].node.state.size > 0, 4000)
    const answer = await pullNode(c)
    const local = captureNode(rts[0].node)
    //! the moving parts (the pull's own journal rows, and the links table the session itself appears in)
    // are compared by prefix/identity; everything else must be byte-equal
    for (const k of ['uuid', 'name', 'listen', 'seq', 'epoch', 'view', 'gate', 'pendingWrites', 'client', 'replicas', 'holders', 'stateHash', 'streams', 'logs', 'state'] as const)
      assert.deepEqual(answer.node[k], local[k], `${k} must match the in-process fold`)
    assert.deepEqual(answer.node.journal.slice(0, 20), local.journal.slice(0, 20), 'journal prefix identical')
    //! the pulled slice is a REAL capture: the model's replay oracle refolds it to the same end state
    const cap = { v: 1, kind: 'live', vocab: answer.vocab, seed: null, nodes: [answer.node] }
    for (const r of verifyReplay(cap) as { ok: boolean; uuid: string; reason?: string }[])
      assert.ok(r.ok, `replay-refold on a WIRE-pulled slice (${r.uuid}: ${r.reason ?? ''})`)
    //! and the topology plane: the pulled link table (the DIAG session's own row included — uuid '', diag true)
    // and watermark ladder refold from the pulled journal; `client` rides the wire so the single-feeder rule can
    for (const r of verifyTopology(cap) as { ok: boolean; uuid: string; reason?: string }[])
      assert.ok(r.ok, `topology-refold on a WIRE-pulled slice (${r.uuid}: ${r.reason ?? ''})`)
  } finally { c.close(); await stop() }
})

test('the pool: answering nodes render, every failure is a typed absent row, nothing is invented', async () => {
  const { rts, addrs, stop } = await spin(2)
  const dead = `127.0.0.1:${await ports.free()}` // nothing listens there
  const pool = new AttachPool([...addrs, dead], TOKEN)
  const badPool = new AttachPool([addrs[0]], 'wrong-token-abcd')
  try {
    for (let i = 0; i < 6; i++) rts[i % 2].write([{ type: REC.update, key: [`k${i}`], value: i }])
    await until(() => rts[1].node.state.size >= 3 && rts[0].node.state.size >= 3, 4000)
    const cap = await pool.capture()
    assert.equal(cap.nodes.length, 2, 'exactly the answering nodes')
    assert.deepEqual(cap.nodes.map((n) => n.uuid).sort(), ['n1', 'n2'])
    assert.deepEqual(cap.absent, [{ target: dead, reason: 'refused' }], 'the dead target is named, not dropped')
    assert.ok(!cap.nodes.some((n) => n.listen === dead), 'never synthesized into nodes[]')
    //! the folds work on an attached capture, and absence contributes ZERO facts to them
    const s = summarize(cap) as { nodes: number; absent: unknown[]; converged: boolean }
    assert.equal(s.nodes, 2)
    assert.deepEqual(s.absent, [{ target: dead, reason: 'refused' }])
    const withoutAbsent = summarize({ ...cap, absent: [] }) as { converged: boolean }
    assert.equal(s.converged, withoutAbsent.converged, 'an absent row changes the header and nothing else')
    assert.deepEqual([...(routes(cap) as Map<string, unknown>).keys()], [...(routes({ ...cap, absent: [] }) as Map<string, unknown>).keys()])
    //! a bad token is a sticky 'unauthorized' — never a fabricated slice, never a redial storm
    const bad = await badPool.capture()
    assert.deepEqual(bad.nodes, [])
    assert.deepEqual(bad.absent, [{ target: addrs[0], reason: 'unauthorized' }])
    assert.equal(summarize(bad).converged, null, 'zero nodes ⇒ no vacuous green')
    const again = await badPool.capture()
    assert.deepEqual(again.absent, [{ target: addrs[0], reason: 'unauthorized' }], 'the deny sticks')
  } finally { pool.close(); badPool.close(); await stop() }
})

//! a node whose answer is too big for one frame says so ({ok:0, e:'too-large'}, kernel/diag.ts reply) — the
// absent row must name it 'frame' (the answer does not fit in a message), not 'error' (a question it cannot
// answer). A stub DIAG node: it latches any HELLO and answers every DIAGQ with the kernel's own too-large reply.
test("an answer too big for one frame is absent 'frame', not 'error'", async () => {
  const net = await import('node:net')
  const { Framer, VERB: V, encodeControl: enc } = await import('../../kernel/codec.ts')
  const server = net.createServer((sock) => {
    const framer = new Framer()
    sock.on('data', (chunk: Buffer) => {
      for (const f of framer.push(new Uint8Array(chunk))) {
        if (f.verb === V.HELLO) sock.write(enc(V.DIAGA, { id: 0, ok: 1, u: 'big', i: 1, p: 1 }))
        else if (f.verb === V.DIAGQ) sock.write(enc(V.DIAGA, { id: (f.value as { id: number }).id, u: 'big', i: 1, ok: 0, e: 'too-large' }))
      }
    })
    sock.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = `127.0.0.1:${(server.address() as { port: number }).port}`
  const pool = new AttachPool([addr], TOKEN)
  try {
    const cap = await pool.capture()
    assert.deepEqual(cap.nodes, [])
    assert.deepEqual(cap.absent, [{ target: addr, reason: 'frame' }])
  } finally { pool.close(); await new Promise<void>((r) => server.close(() => r())) }
})

test('the coalescer: concurrent rebuilds share ONE fan-out (the poll is the only cadence)', async () => {
  const { addrs, stop } = await spin(1)
  const pool = new AttachPool(addrs, TOKEN)
  try {
    const [a, b, c] = await Promise.all([pool.capture(), pool.capture(), pool.capture()])
    assert.equal(a, b, 'identical object identity ⇒ one fan-out served all three')
    assert.equal(b, c)
    const later = await pool.capture()
    assert.notEqual(later, a, 'a later request rebuilds fresh — no stale cache')
  } finally { pool.close(); await stop() }
})

test('vocab: the union renders honest skew; a CONFLICTING mapping demotes that node to absent', async () => {
  const { rts, addrs, stop } = await spin(2)
  const [c0, c1] = addrs.map((a) => new DiagClient(a, TOKEN))
  try {
    const a0 = await pullNode(c0)
    const a1 = await pullNode(c1)
    const { captureAttached } = await import('./capture.ts')
    //! honest skew (a node from a newer build knows one extra kind): the union renders both
    const newer = { ...a1, vocab: { ...a1.vocab, futureKind: 99 } }
    const u = captureAttached([a0, newer], [])
    assert.equal(u.nodes.length, 2)
    assert.equal(u.vocab.futureKind, 99, 'the superset survives the union')
    //! a LYING vocabulary (same name, different code) cannot be reconciled — that node is absent, named
    const liar = { ...a1, vocab: { ...a1.vocab, dial: 999 } }
    const v = captureAttached([a0, liar], [])
    assert.deepEqual(v.nodes.map((n) => n.uuid), [rts[0].node.uuid])
    assert.deepEqual(v.absent, [{ target: liar.target, reason: 'vocab-mismatch' }])
  } finally { c0.close(); c1.close(); await stop() }
})

//! a key this runtime OWNS: its write stamps a writeLocal row synchronously (a forwarded key would not touch its own
// journal until the owner's commit came back) — probed, never assumed, so a mid-pull row below is deterministic
const ownedKey = (r: Runtime): string => {
  for (let i = 0; i < 32; i++) {
    const key = `own${i}`, before = r.node.journal.n
    r.write([{ type: REC.update, key: [key], value: 0 }])
    if (r.node.journal.read(before).some((e) => e.kind === JK.writeLocal)) return key
  }
  assert.fail('no owned key in 32 probes')
}

//! a client whose FIRST q:'node' reply is followed, synchronously, by one local write on the pulled runtime — the
// row that lands between the snapshot and the rest of the pull; returns the snapshot's journal head as the reply said it
const writeAfterSnapshot = (c: DiagClient, r: Runtime, key: string) => {
  const q = c.q.bind(c)
  const seen = { jn: -1 }
  c.q = async (body, ms) => {
    const v = await q(body, ms)
    if (body.q === 'node' && seen.jn < 0) { seen.jn = (v.n as { jn: number }).jn; r.write([{ type: REC.update, key: [key], value: 'mid-pull' }]) }
    return v
  }
  return seen
}

test('a node that writes MID-PULL still pulls as ONE snapshot: the journal is cut at the snapshot head, so its links/streams refold (ISSUES I-18)', async () => {
  const { rts, addrs, stop } = await spin(2)
  const c = new DiagClient(addrs[0], TOKEN)
  try {
    const key = ownedKey(rts[0])
    await until(() => rts[1].node.state.size > 0, 4000)
    const seen = writeAfterSnapshot(c, rts[0], key)
    const answer = await pullNode(c)
    assert.ok(seen.jn > 0, 'the mid-pull write fired after the snapshot')
    const cap = { v: 1, kind: 'live', vocab: answer.vocab, seed: null, nodes: [answer.node] }
    const [t] = verifyTopology(cap) as { ok: boolean; reason?: string }[]
    assert.ok(t.ok, `the snapshot's links/streams and its journal are one instant (${t.reason ?? ''})`)
    //! rows that landed after the snapshot belong to the NEXT pull: the journal ends exactly at the snapshot head
    assert.ok(answer.node.journal.every((e) => e.t < seen.jn), 'no row past the snapshot head')
    assert.equal(answer.node.journal[answer.node.journal.length - 1].t, seen.jn - 1, 'and nothing below it is missing')
  } finally { c.close(); await stop() }
})

test('a state that moved MID-PULL is a torn read, flagged on the slice and said in the header — never painted as replay ✗ (ISSUES I-2)', async () => {
  const { bootViewer } = await import('./dom-shim.ts')
  const { rts, addrs, stop } = await spin(2)
  const c = new DiagClient(addrs[0], TOKEN)
  try {
    const key = ownedKey(rts[0])
    await until(() => rts[1].node.state.size > 0, 4000)
    //! quiet: nothing lands during the pull — no flag, and the replay oracle is satisfied
    const quiet = await pullNode(c)
    assert.equal(quiet.node.torn, undefined, 'a quiet pull carries no torn flag')
    const capQ = { v: 1, kind: 'live', vocab: quiet.vocab, seed: null, nodes: [quiet.node] }
    assert.ok((verifyReplay(capQ) as { ok: boolean }[])[0].ok)
    const q = await bootViewer('attached', capQ, { search: '' })
    assert.match(q.el('statusRight').innerHTML, /replay ✓/); assert.doesNotMatch(q.el('statusRight').innerHTML, /torn read/)
    //! torn: a write lands right after the snapshot, so the state pulled next is a later instant than the journal
    const seen = writeAfterSnapshot(c, rts[0], key)
    const answer = await pullNode(c)
    assert.ok(seen.jn > 0)
    assert.equal(answer.node.torn, true, 'the slice says it is torn')
    const cap = { v: 1, kind: 'live', vocab: answer.vocab, seed: null, nodes: [answer.node] }
    assert.equal((verifyReplay(cap) as { ok: boolean }[])[0].ok, false, 'the state holds the mid-pull write, the journal (cut at the snapshot) does not — a mismatch the flag explains')
    const { el } = await bootViewer('attached', cap, { search: '' })
    assert.match(el('statusRight').innerHTML, /class="sst warn" data-tip="torn-read">torn read n1/, 'the header says torn read, amber')
    assert.doesNotMatch(el('statusRight').innerHTML, /replay ✗/, 'and never claims a replay fault')
  } finally { c.close(); await stop() }
})

test('diag.allow on a REAL fero(): the attach pool reads a composed cluster with the token, and a node without the key is denied (the config door, end to end)', async () => {
  const [a, b] = [`127.0.0.1:${await ports.free()}`, `127.0.0.1:${await ports.free()}`]
  //! one server opens the channel through the public config key; its peer does not
  const s1 = await fero('shop', { uuid: 's1', listen: a, hosts: [b], heartbeat: { ms: 100 }, diag: { allow: { ops: TOKEN } } })
  const s2 = await fero('shop', { uuid: 's2', listen: b, hosts: [a], heartbeat: { ms: 100 } })
  const pool = new AttachPool([a, b], TOKEN)
  try {
    s1.data.k = 1
    await until(() => (s2.snapshot as Record<string, unknown>).k === 1, 4000)
    const cap = await pool.capture()
    assert.deepEqual(cap.nodes.map((n) => [n.uuid, n.name, n.listen]), [['s1', 'shop', a]], 'the composed node answered, its resource name riding the slice')
    assert.deepEqual(cap.absent, [{ target: b, reason: 'unauthorized' }], 'a fero() with no diag key keeps the channel dead')
    assert.ok(cap.nodes[0].state.some(([k]) => String(k).includes('"k"')), 'and the slice is the real node: its row is there')
  } finally { pool.close(); await s2.destroy(); await s1.destroy() }
})

//! ── the DIAG wire's deltas, caching and paging (wave 5e) — driven against kernel Nodes IN-PROCESS: each question runs
// the kernel's own onDiagQ on a stand-in link and decodes the DIAGA it ships, so a restart, a ring wrap, a compaction
// or a hand-off happens exactly between two pulls. The bar every case holds: the cached slice deepEquals the
// in-process captureNode of the same instant (journal by prefix: the pulls themselves journal diagPull rows after it).
type Asked = Record<string, unknown>
const kernelPuller = (get: () => Node, opts: { frame?: number; before?: (body: Asked) => void } = {}) => {
  let id = 1
  const asked: Asked[] = []
  const p: Puller & { asked: Asked[] } = {
    target: 'k', asked,
    get peer() { const n = get(); return { u: n.uuid, i: n.incarnation } },
    q: async (body) => {
      asked.push(body)
      opts.before?.(body)
      const node = get()
      //! a frame that holds only `frame` cells: a whole state or a bigger page is too large for it (the real ceiling is 256 MiB)
      if (opts.frame !== undefined && body.q === 'state' && (body.n === undefined || (body.n as number) > opts.frame)) throw new Error('too-large')
      const fr = new Framer()
      let out: Asked | null = null
      const link = { id: 99, ship: (bytes: Uint8Array) => { for (const f of fr.push(bytes)) if (f.verb === VERB.DIAGA) out = f.value as Asked } }
      onDiagQ(node, link as never, { id: id++, ...body })
      const v = out as unknown as Asked
      if (v.ok !== 1) throw new Error(v.e === 'too-large' ? 'too-large' : 'error')
      return v
    },
  }
  return p
}
const DIAGPULL = JK.diagPull
//! parity at one instant: everything equal, the journal equal up to the slice's own end, and every local row past it one of this pull's diagPull rows
// (on a tiny ring the pull's own rows can push the oldest rows out after the slice was cut: there the journal is
// compared row for row over the t both hold, and the slice may start a little lower than the capture does)
const sameAsLocal = (answer: Awaited<ReturnType<typeof pullNode>>, node: Node, why: string, ring = false) => {
  const local = captureNode(node)
  for (const k of ['uuid', 'seq', 'epoch', 'view', 'gate', 'stateHash', 'streams', 'logs', 'state', ...(ring ? [] : ['dropped'] as const)] as const)
    assert.deepEqual(answer.node[k], local[k], `${why}: ${k} must match the in-process capture`)
  const j = answer.node.journal
  const lj = ring ? local.journal.filter((e) => e.t <= (j.at(-1)?.t ?? -1)) : local.journal.slice(0, j.length)
  assert.deepEqual(ring ? j.filter((e) => e.t >= (lj[0]?.t ?? Infinity)) : j, lj, `${why}: the journal is the capture's, row for row`)
  assert.ok(local.journal.filter((e) => e.t > (j.at(-1)?.t ?? -1)).every((e) => e.kind === DIAGPULL), `${why}: nothing past the slice but this pull's own diagPull rows`)
}
const journalAsks = (p: { asked: Asked[] }, from: number) => p.asked.slice(from).filter((b) => b.q === 'journal').map((b) => b.f)
const logAsks = (p: { asked: Asked[] }, from: number) => p.asked.slice(from).filter((b) => b.q === 'logs')

test('journal deltas: a second pull asks only from the first pull\'s head, and the cached slice is still the capture, row for row (wave 5e)', async () => {
  const sim = new Sim(4)
  const nodes = cluster(sim, 2, { heartbeatMs: 50 })
  writes(sim, nodes, 6, 100); sim.run({ until: 1000 })
  const p = kernelPuller(() => sim.nodes.get('n01')!)
  const a1 = await pullNode(p)
  sameAsLocal(a1, nodes[0], 'first pull')
  assert.deepEqual(journalAsks(p, 0), [0], 'the first pull reads the journal from 0')
  const head = a1.node.journal.at(-1)!.t + 1
  writes(sim, nodes, 6, 100); sim.run({ until: 2000 })
  const mark = p.asked.length
  const a2 = await pullNode(p)
  sameAsLocal(a2, nodes[0], 'second pull')
  const asks = journalAsks(p, mark) as number[]
  assert.equal(asks[0], head, 'the delta starts at the snapshot head the first pull cut at')
  assert.ok(asks.every((f) => f >= head), 'and never re-reads a row it holds')
  assert.ok(a2.node.journal.length > a1.node.journal.length, 'new rows came in')
  assert.deepEqual(a2.node.journal.slice(0, a1.node.journal.length), a1.node.journal, 'the old rows are kept, the new ones appended')
})

test('journal deltas are safe across a restart (a new life starts the cursor at 0) and a ring wrap (a hole past the cursor is never spliced) (wave 5e)', async () => {
  //! restart: a durable pair, the puller follows n01's current Node object
  const sim = new Sim(21)
  const pair = cluster(sim, 2, { durable: true }); writes(sim, pair, 6, 100); sim.run()
  const p = kernelPuller(() => sim.nodes.get('n01')!)
  const a1 = await pullNode(p)
  sameAsLocal(a1, sim.nodes.get('n01')!, 'before the restart')
  const i1 = sim.nodes.get('n01')!.incarnation
  sim.restart('n01'); sim.run()
  for (let i = 0; i < 3; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: [`after${i}`], value: i }] }, i * 5)
  sim.run()
  assert.ok(sim.nodes.get('n01')!.incarnation > i1, 'a new incarnation — the fixture restarted')
  const mark = p.asked.length
  const a2 = await pullNode(p)
  assert.equal(journalAsks(p, mark)[0], 0, 'a new life: the journal is read from 0 again')
  sameAsLocal(a2, sim.nodes.get('n01')!, 'after the restart')
  //! ring wrap: a 64-row ring, pulled, then far more than 64 rows before the next pull
  const sim2 = new Sim(5)
  const small = ['s1', 's2'].map((uuid, i, all) => sim2.add({ uuid, listen: `sim:${uuid}`, hosts: all.filter((_, j) => j !== i).map((u) => `sim:${u}`), redialMs: 20, journalCap: 64 }))
  for (const n of small) sim2.post(n.uuid, { kind: 'start' })
  sim2.run()
  const q = kernelPuller(() => small[0])
  const b1 = await pullNode(q)
  sameAsLocal(b1, small[0], 'before the wrap', true)
  writes(sim2, small, 80, 200); sim2.run()
  const b2 = await pullNode(q)
  assert.ok(small[0].journal.dropped > b1.node.journal.at(-1)!.t, 'the ring wrapped past the old cursor — the fixture is what it claims')
  assert.equal(b2.node.journal[0].t, b2.node.dropped, 'the slice starts where its dropped says, no hole below')
  assert.ok(b2.node.journal.every((e, i) => i === 0 || e.t === b2.node.journal[i - 1].t + 1), 'and runs without a gap')
  sameAsLocal(b2, small[0], 'after the wrap', true)
})

test('the log cache: an unchanged book asks no log entries, a new write asks only the tail, and compaction and hand-offs leave nothing stale (wave 5e)', async () => {
  //! compaction: compactAt 8 — losers below the frontier leave the book between two pulls
  const sim = new Sim(4)
  const nodes = cluster(sim, 2, { heartbeatMs: 50, tune: { compactAt: 8 } })
  sim.run({ until: 1000 })
  for (let i = 0; i < 6; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['k' + (i % 3)], value: i }] }, i * 5)
  sim.run({ until: 1500 })
  const p = kernelPuller(() => nodes[0])
  sameAsLocal(await pullNode(p), nodes[0], 'first pull')
  let mark = p.asked.length
  sameAsLocal(await pullNode(p), nodes[0], 'an unchanged pull')
  assert.equal(logAsks(p, mark).length, 0, 'nothing changed: no log entry is asked for')
  assert.ok(p.asked.slice(mark).some((b) => b.q === 'seqs'), 'only which seqs are there')
  //! one write (stamped by its key's owner, either lane): exactly the lane whose tail moved is asked, from just below the new entry
  const tails = () => new Map([...nodes[0].logs].map(([o, e]) => [o, e.length ? e[e.length - 1].seq : 0]))
  const t0 = tails()
  sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['k0'], value: 'new' }] })
  sim.run({ until: 1510 })
  const moved = [...tails()].filter(([o, t]) => t !== t0.get(o))
  assert.equal(moved.length, 1, 'one lane took the write — the fixture is what it claims')
  mark = p.asked.length
  sameAsLocal(await pullNode(p), nodes[0], 'after one write')
  assert.deepEqual(logAsks(p, mark).map((b) => [b.o, b.f]), [[moved[0][0], moved[0][1] - 1]], 'one log question, for the new entry alone')
  for (let i = 0; i < 30; i++) sim.post('n01', { kind: 'write', recs: [{ type: REC.update, key: ['k' + (i % 3)], value: i }] }, i * 5)
  sim.run({ until: 3000 })
  assert.ok(nodes[0].journal.read().some((e) => e.kind === JK.compacted), 'the book compacted between the pulls — the fixture is what it claims')
  sameAsLocal(await pullNode(p), nodes[0], 'after compaction')
  //! hand-offs: a scoped cluster pulled before a join; the join sheds rows from some members and copies rows into others
  const s2 = new Sim(11)
  const four = cluster(s2, 4, { heartbeatMs: 50, replicas: 2 })
  writes(s2, four, 6, 100); s2.run({ until: 1500 }); writes(s2, four, 8, 200); s2.run({ until: 4000 })
  const pullers = four.map((n) => kernelPuller(() => n))
  for (const [i, pl] of pullers.entries()) sameAsLocal(await pullNode(pl), four[i], `${four[i].uuid} before the join`)
  s2.add({ uuid: 'n05', listen: 'sim:n05', hosts: four.map((n) => n.listen), heartbeatMs: 50, replicas: 2, redialMs: 20, journalCap: 1 << 16 })
  s2.post('n05', { kind: 'start' }); s2.run({ until: 12000 })
  assert.ok(four.some((n) => n.journal.read().some((e) => e.kind === JK.shed)) && four.some((n) => n.journal.read().some((e) => e.kind === JK.acquire)), 'the join shed and acquired rows — the fixture is what it claims')
  for (const [i, pl] of pullers.entries()) sameAsLocal(await pullNode(pl), four[i], `${four[i].uuid} after the join`)
})

