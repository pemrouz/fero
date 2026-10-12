//! Tier-3 pin, real sockets and real WALs (wave 6b, 2026-10-12): one-at-a-time clean stops, then a restart of the first two
// with the last still down — the shape the platform spikes found (`~/.claude/plans/fero-platform/spikes/local/r2/`,
// restart-all a2) and STATUS names: "After every member stops cleanly one at a time, only the last to stop can bring the
// cluster back". Each leaver's dir holds the view it saw last, one it is not in ({bb,cc}@2, {cc}@3), and the last member's
// holds its solo view ({cc}@3); back from their dirs, the first two are outside the last view they know and can rejoin it
// only through a live member of it — cc — so they sit read-only, `joining`, for good, and start writing again the moment
// cc is back. Pinned as today's behaviour on purpose: DESIGN-LEAVE §10.7's note of 2026-10-12 argues that no kernel rule
// can re-form the two without cc safely (a re-form splits when cc comes back and self-ballots its solo view; dead and
// down look the same from here), and specifies the operator's word that would. The sim twin is sim/leave-harness.ts
// stopsOneByOne.
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Runtime, restoreOpts } from '../shell/runtime.ts'
import { REC } from '../kernel/env.ts'
import { ports, until } from '#utils'

const HB = 50

test('one-at-a-time clean stops on real sockets and WALs: three durable members leave cleanly in turn; the first two back from their dirs with the last down sit `joining` at the last view {cc}@3 and take no write; the last back brings all three to one writable view', async () => {
  const ids = ['aa', 'bb', 'cc'] as const
  const dirs = ids.map((u) => fs.mkdtempSync(path.join(os.tmpdir(), `fero-stops-${u}-`)))
  const live: Runtime[] = []
  try {
    const ps = [await ports.free(), await ports.free(), await ports.free()]
    const addr = (i: number) => `127.0.0.1:${ps[i]}`
    const make = (i: number, restore: boolean) => new Runtime({ uuid: ids[i], listen: addr(i), hosts: [0, 1, 2].filter((j) => j !== i).map(addr), dir: dirs[i], heartbeatMs: HB, redialMs: 30, ...(restore ? restoreOpts(dirs[i]) : {}) })
    const first = [0, 1, 2].map((i) => make(i, false))
    live.push(...first)
    for (const r of first) await r.start()
    assert.ok(await until(() => first.every((r) => r.node.epoch === 1 && r.node.membership.gate(r.node).open), 10_000), 'the three formed, writable')
    first[0].write([{ type: REC.update, key: ['row'], value: 'before the stops' }])
    assert.ok(await until(() => first.every((r) => r.node.state.size === 1), 5_000), 'the row is on all three')
    //! the clean stops, one at a time, each waited for: aa (the lowest) proposes its own exit, bb knocks at cc, cc is the last
    const verdicts: boolean[] = []
    for (const r of first) { verdicts.push(await r.leave()); await r.destroy(); live.splice(live.indexOf(r), 1) }
    assert.deepEqual(verdicts, [true, true, true], 'every stop was clean (the last had nothing to leave)')
    //! the first two come back; cc stays down (a lost machine or volume)
    const a2 = make(0, true), b2 = make(1, true)
    live.push(a2, b2)
    a2.restore(); b2.restore()
    assert.deepEqual([a2.node.epoch, a2.node.membership.view.members.map((m) => m[0])], [2, ['bb', 'cc']], 'aa\'s dir holds the view it left: {bb,cc}@2')
    assert.deepEqual([b2.node.epoch, b2.node.membership.view.members.map((m) => m[0])], [3, ['cc']], 'bb\'s dir holds the view it left: {cc}@3')
    await a2.start(); await b2.start()
    assert.ok(await until(() => a2.node.admitted().length === 1 && b2.node.admitted().length === 1, 10_000), 'the two linked')
    await new Promise((r) => setTimeout(r, HB * 30)) // thirty heartbeats: past rejoinTicks (10) and any JOIN relay
    for (const r of [a2, b2]) {
      assert.equal(r.node.epoch, 3, `${r.node.uuid} at the last view it knows`)
      assert.deepEqual(r.node.membership.view.members.map((m) => m[0]), ['cc'], `${r.node.uuid}: the last view holds cc alone`)
      assert.deepEqual(r.node.membership.gate(r.node), { open: false, reason: 'joining' }, `${r.node.uuid} is outside it, with nobody of it to join through`)
    }
    a2.write([{ type: REC.update, key: ['row'], value: 'while cc is down' }])
    await new Promise((r) => setTimeout(r, HB * 4))
    assert.equal(a2.node.state.get(JSON.stringify(['row'])) === undefined ? '' : JSON.stringify(a2.node.state.get(JSON.stringify(['row']))).includes('while cc is down'), false, 'the write parks: a read-only pair takes nothing')
    //! cc comes back: it confirms its solo view, the two join it, and the write lands
    const c2 = make(2, true)
    live.push(c2)
    c2.restore()
    await c2.start()
    assert.ok(await until(() => [a2, b2, c2].every((r) => r.node.epoch >= 4 && r.node.membership.view.members.length === 3 && r.node.membership.gate(r.node).open), 15_000), `all three writable in one view (${[a2, b2, c2].map((r) => `${r.node.uuid}@${r.node.epoch}{${r.node.membership.view.members.map((m) => m[0])}} ${r.node.membership.gate(r.node).reason}`).join(' ')})`)
    assert.ok(await until(() => [a2, b2, c2].every((r) => JSON.stringify(r.node.state.get(JSON.stringify(['row']))).includes('while cc is down')), 5_000), 'the parked write flushed and reached every member')
  } finally {
    for (const r of live) await r.destroy()
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  }
})
