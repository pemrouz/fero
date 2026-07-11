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
import { until } from '#utils'

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
