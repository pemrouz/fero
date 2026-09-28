//! Tier-3 real-WAL smoke: the shell store exercised against a REAL filesystem — append+fsync per
// batch, the atomic boot record, restore-then-network. Like tcp.test.ts this validates the ADAPTER
// (the protocol's durability coverage is sim/durability.test.ts); it is deliberately thin and it is
// the only tier allowed real disks and wall-clock waits. The M4e twin (full-cluster restore under a
// workload) builds on exactly this seam.

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Runtime, restoreOpts } from '../shell/runtime.ts'
import { REC } from '../kernel/env.ts'
import { JK } from '../kernel/journal.ts'
import { Ring } from '../kernel/ring.ts'
import { ports, until } from '#utils'

test('a solo durable node survives a hard restart: WAL + boot record restore state, clock, lane, and incarnation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-'))
  //! runtimes are torn down in finally: a failed assertion must not leave live handles hanging the runner
  let a: Runtime | null = null
  let b: Runtime | null = null
  try {
    //! first life: three writes, wait for the fsync echoes (durable watermark = proof the WAL resolved)
    a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    await a.start()
    a.write([{ type: REC.update, key: ['x'], value: { n: 1 } }])
    a.write([{ type: REC.update, key: ['y'], value: 'two' }])
    a.write([{ type: REC.remove, key: ['x'] }])
    assert.ok(await until(() => (a!.node.streams.get('aa')?.durable ?? 0) === 3), 'all batches fsync-resolved')
    const hash = a.node.stateHash
    const seq = a.node.seq
    await a.destroy() // the "crash" — nothing is flushed beyond what already resolved
    a = null
    //! second life: restore BEFORE the network, from nothing but the directory
    const facts = restoreOpts(dir)
    assert.equal(facts.incarnation, 2, 'the boot record carried incarnation 1; the heir bumps it')
    b = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir, ...facts })
    b.restore()
    assert.equal(b.node.stateHash, hash, 'state folded back from the WAL alone')
    assert.equal(b.node.state.size, 1, 'the remove replayed too — x is gone, y survives')
    assert.ok(b.node.seq >= seq, 'the Lamport clock never went backwards through the restart')
    assert.equal(b.node.origin, 'aa~2', 'the reborn life stamps under its own provenance lane')
    await b.start()
    b.write([{ type: REC.update, key: ['z'], value: 3 }])
    //! the first post-restore stamp lands in the NEW LANE, just past the durable CEILING (the Lamport
    // lease) — the unspent lease window is skipped, so cross-life seq reuse is impossible, and the old
    // lane stays the immutable history the WAL restored
    assert.equal(b.node.logs.get('aa~2')![0].seq, facts.boot!.lamport! + 1, 'post-restore stamps resume past the leased ceiling')
    assert.equal(b.node.logs.get('aa')!.length, 3, 'the restored lane is untouched by new writes')
  } finally {
    await a?.destroy()
    await b?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M4-REVIEW PIN — a CLEAN destroy flushes every queued append: committed writes reach the disk before the fd closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-flush-'))
  let a: Runtime | null = null
  let b: Runtime | null = null
  try {
    a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    await a.start()
    //! write a burst and destroy IMMEDIATELY — no waiting for fsync echoes: the io-queue must drain
    // to disk during destroy() (the review found these rows were silently dropped on clean shutdown)
    for (let i = 0; i < 8; i++) a.write([{ type: REC.update, key: [`k${i}`], value: i }])
    const hash = a.node.stateHash
    await a.destroy()
    a = null
    b = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir, ...restoreOpts(dir) })
    b.restore()
    assert.equal(b.node.stateHash, hash, 'every committed write survived the clean shutdown')
    assert.equal(b.node.state.size, 8)
  } finally {
    await a?.destroy()
    await b?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('M4-REVIEW PIN — interior corruption on a real WAL is a VERDICT, not a tear: valid rows beyond it condemn the restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-corrupt-'))
  let a: Runtime | null = null
  let b: Runtime | null = null
  try {
    a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    await a.start()
    for (let i = 0; i < 3; i++) a.write([{ type: REC.update, key: [`k${i}`], value: i }])
    assert.ok(await until(() => (a!.node.streams.get('aa')?.durable ?? 0) === 3))
    await a.destroy()
    a = null
    //! flip one byte in the MIDDLE of the file: rows after it are intact and crc-valid — the resync
    // scan must find them and hand the kernel the impossible chain link that condemns the disk
    const p = path.join(dir, 'wal.log')
    const bytes = fs.readFileSync(p)
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    fs.writeFileSync(p, bytes)
    b = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir, ...restoreOpts(dir) })
    b.restore()
    assert.equal(b.node.tainted, true, 'corruption with intact rows beyond it is proof, and the verdict fires')
    assert.equal(b.node.state.size, 0, 'the fold reset — a corrupt disk\'s prefix is not evidence')
  } finally {
    await a?.destroy()
    await b?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the M4e twin on real disks: a two-node cluster is killed whole — both restore from their WALs (one swapped) and reconverge', async () => {
  const da = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-a-'))
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-b-'))
  const live: Runtime[] = []
  try {
    //! first lives: a real mesh, writes on both sides, everything fsync-resolved before the kill
    const pa = await ports.free()
    const pb = await ports.free()
    const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, dir: da })
    const b = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], dir: db })
    live.push(a, b)
    await a.start()
    await b.start()
    assert.ok(await until(() => a.node.admitted().length === 1 && b.node.admitted().length === 1), 'mesh formed')
    a.write([{ type: REC.update, key: ['left'], value: 'from aa' }])
    b.write([{ type: REC.update, key: ['right'], value: 'from bb' }])
    assert.ok(await until(() =>
      a.node.state.size === 2 && b.node.state.size === 2 &&
      ['aa', 'bb'].every((o) => a.node.streams.get(o)!.durable > 0 && b.node.streams.get(o)!.durable > 0),
    ), 'both writes replicated AND durable on both disks')
    //! the REAL swap on aa: tmp + fsync + rename + reopen — then an append must chain onto the new file
    a.node.snapshot()
    assert.ok(await until(() => a.node.journal.read().some((e) => e.kind === JK.snapshot) &&
      !fs.existsSync(path.join(da, 'wal.log.tmp'))), 'the swap landed atomically')
    a.write([{ type: REC.update, key: ['after-swap'], value: true }])
    const tail = () => a.node.seq
    const want = tail()
    assert.ok(await until(() => a.node.streams.get('aa')!.durable >= want), 'the post-swap append fsync-resolved on the NEW file')
    assert.ok(await until(() => b.node.state.size === 3), 'and replicated')
    const hashA = a.node.stateHash
    const hashB = b.node.stateHash
    //! the whole-cluster kill: both processes gone at once — three files each are all that remain
    await a.destroy()
    await b.destroy()
    live.length = 0
    //! second lives: restore BOTH from disk alone (no live peer to lean on), then re-form and verify
    const a2 = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, dir: da, ...restoreOpts(da) })
    const b2 = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], dir: db, ...restoreOpts(db) })
    live.push(a2, b2)
    a2.restore()
    b2.restore()
    assert.equal(a2.node.stateHash, hashA, 'aa restored from the swapped WAL + chained appends, before any network')
    assert.equal(b2.node.stateHash, hashB, 'bb restored from its append-only WAL')
    assert.equal(a2.node.incarnation, 2)
    await a2.start()
    await b2.start()
    assert.ok(await until(() => a2.node.admitted().length === 1 && b2.node.admitted().length === 1), 'the reborn mesh formed')
    //! alive, not a museum: a fresh write from the restored side still replicates
    b2.write([{ type: REC.update, key: ['post-restore'], value: 'alive' }])
    assert.ok(await until(() => a2.node.state.size === 4 && a2.node.stateHash === b2.node.stateHash), 'reconverged')
  } finally {
    for (const r of live) await r.destroy()
    fs.rmSync(da, { recursive: true, force: true })
    fs.rmSync(db, { recursive: true, force: true })
  }
})

test('I-36 — the WAL dir deleted under a running member: the next boot record condemns the store (durable never advances again), the clean leave still completes, nothing is thrown', async () => {
  const da = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-gone-a-'))
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-wal-gone-b-'))
  const live: Runtime[] = []
  //! before the fix the ENOENT escaped a socket 'data' handler (persistBoot inside the vote's bytesIn step)
  // and killed the process mid-leave — trapped here so a regression reads as a failed assertion
  const uncaught: unknown[] = []
  const trap = (e: unknown) => { uncaught.push(e) }
  process.on('uncaughtException', trap)
  try {
    const pa = await ports.free()
    const pb = await ports.free()
    //! heartbeats ON and a static mesh both ways (genesis: the lowest uuid proposes once its links cover its
    // hosts): a committed two-member view, so bb's leave is a real ballot — LEAVE to aa, aa proposes, bb
    // VOTES — and the vote's boot record is a write into the gone directory
    const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], dir: da, heartbeatMs: 50, redialMs: 30 })
    const b = new Runtime({ uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], dir: db, heartbeatMs: 50, redialMs: 30 })
    live.push(a, b)
    await a.start()
    await b.start()
    assert.ok(await until(() => a.node.membership.view.members.length === 2 && b.node.membership.view.members.length === 2), 'a two-member view committed')
    //! keys bb OWNS under the ring: bb stamps and persists them itself (the other half is forwarded to aa
    // and would prove nothing about bb's disk). The kernel builds its ring lazily on the first write, so
    // the lookup is a private Ring over the same committed view — ownership is a pure function of it.
    const ring = new Ring()
    ring.build(b.node.membership.view.epoch, b.node.membership.view.members)
    const mine = (i: number) => {
      for (let n = 0; n < 256; n++) { const k = `k${i}-${n}`; if (ring.ownerOf(k) === 'bb') return k }
      throw new Error('no key of 256 hashed to bb')
    }
    b.write([{ type: REC.update, key: [mine(0)], value: 1 }])
    assert.ok(await until(() => (b.node.streams.get('bb')?.durable ?? 0) >= 1), 'the store works: the write fsync-resolved')
    const durable = b.node.streams.get('bb')!.durable
    //! the dir goes under the running member. The append fd stays open on the unlinked file, so appends and
    // fsyncs keep SUCCEEDING — only a boot record (a vote, a view install, the Lamport lease) touches the
    // directory. persistBoot() here IS that next record.
    fs.rmSync(db, { recursive: true, force: true })
    b.node.persistBoot()
    assert.ok(await until(() => b.node.journal.read().some((e) => e.kind === JK.persistFail)), 'the failed boot record is the store\'s death, surfaced')
    const seq = b.node.seq
    b.write([{ type: REC.update, key: [mine(1)], value: 2 }])
    assert.ok(await until(() => b.node.seq > seq), 'bb still stamps — replication is untouched')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(b.node.streams.get('bb')!.durable, durable, 'but durable never advances again: no persisted answer from a dir that is gone')
    //! the clean leave: the vote ships without its record (the store is dead either way) and the ballot
    // completes — the process lives and the survivor shrinks the view
    assert.equal(await b.leave(), true, 'the leave completed by ballot')
    assert.ok(await until(() => a.node.membership.view.members.length === 1), 'aa alone in the view')
    await b.destroy()
    live.splice(live.indexOf(b), 1)
    assert.deepEqual(uncaught, [], 'nothing escaped')
  } finally {
    process.off('uncaughtException', trap)
    for (const r of live) await r.destroy()
    fs.rmSync(da, { recursive: true, force: true })
    fs.rmSync(db, { recursive: true, force: true })
  }
})
