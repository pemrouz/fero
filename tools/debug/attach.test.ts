//! ── tools/debug/attach.test — the DIAG bridge end-to-end over REAL sockets ───────────────────
// Tier-3: two DIAG-enabled Runtimes + a dead address + a wrong-token target → the assembled capture
// carries exactly the answering nodes, every failure as a typed absent row, and NOTHING invented.
// The parity pin is the load-bearing one: a slice pulled over the wire must deepEqual the in-process
// captureNode of the same node (one fold, two consumers — DESIGN-M7 §1).

import { test } from 'node:test'
import assert from 'node:assert'
import { Runtime } from '../../shell/runtime.ts'
import { AttachPool, DiagClient, pullNode } from './attach.ts'
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
    uuid: `n${i + 1}`, listen: a, hosts: addrs.filter((_, j) => j !== i),
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
    for (const k of ['uuid', 'listen', 'seq', 'epoch', 'view', 'gate', 'pendingWrites', 'client', 'stateHash', 'streams', 'logs', 'state'] as const)
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
