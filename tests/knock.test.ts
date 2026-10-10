//! Tier-3: the knock window over REAL sockets and a REAL stall (DESIGN-LEAVE §10.7, 2026-10-10). The survivor runs
// in a child process that the test STOPS with SIGSTOP — a paused process, exactly the I-20 shape: its TCP socket
// keeps the leaver's knocks, its timers wait, and on SIGCONT it reads them all with the leaver still there to grant.
// Two runs on the same shape, a two-member view with the leaver the lowest member (it proposes its own exit and waits
// for the survivor's vote, then its echo):
//   - the window open (the default rule): the leaver keeps knocking through the stall, the survivor wakes inside the
//     window, votes, echoes — destroy() resolves TRUE after about the stall, under the shell's cap;
//   - the window shut (leaveWindow at the bound: leave.ms 0's meaning): the leaver gives up at the fifth tick while
//     the survivor still sleeps — destroy() resolves FALSE before the stall ends, as every kernel before the window did.
// The shell's cap is the window plus two ticks (plus the drain on a scoped node; tests/wal.test.ts pins that one).
// Heartbeat 100 ms, a 1.2 s stall, a 30-tick window (3 s): the margins are wide on purpose for the loaded WSL2 box.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { Runtime } from '../shell/runtime.ts'
import { JK } from '../kernel/journal.ts'
import { ports, until } from '#utils'

const CHILD = path.join(import.meta.dirname, 'knock.child.ts')
const HB = 100, STALL = 1200

//! survivor — the child, up and listening (it prints `ready` once its Runtime started)
const survivor = async (listen: string, peer: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CHILD, listen, peer, String(HB)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d })
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d })
  assert.ok(await until(() => out.includes('ready'), 15_000), `the survivor child never said ready (stderr: ${err})`)
  return child
}
//! stop — SIGCONT then SIGKILL: a stopped process cannot act on a kill until it is continued
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null) return
  child.kill('SIGCONT'); child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

//! shape — the leaver (aa, the lowest) and the stopped survivor (bb, a child); returns the leave's verdict and timing
const stalledLeave = async (tune: { leaveWindow: number } | undefined) => {
  const pa = await ports.free(), pb = await ports.free()
  const a = new Runtime({ uuid: 'aa', listen: `127.0.0.1:${pa}`, hosts: [`127.0.0.1:${pb}`], heartbeatMs: HB, redialMs: 30, ...(tune ? { tune } : {}) })
  let child: ChildProcess | null = null
  try {
    await a.start()
    child = await survivor(`127.0.0.1:${pb}`, `127.0.0.1:${pa}`)
    assert.ok(await until(() => a.node.epoch === 1 && a.node.membership.view.members.length === 2, 10_000), 'the two-member view formed')
    //! the stall: the survivor's process stops; its socket stays open and keeps whatever aa sends
    assert.ok(child.kill('SIGSTOP'), 'the survivor is stopped')
    await new Promise((r) => setTimeout(r, 2 * HB)) // let a heartbeat or two pass with the child asleep, so nothing is answered live
    const t0 = performance.now()
    const wake = setTimeout(() => child!.kill('SIGCONT'), STALL)
    const clean = await a.leave()
    clearTimeout(wake)
    const took = performance.now() - t0
    const left = a.node.journal.read().filter((e) => e.kind === JK.left).map((e) => e.b)
    return { a, took, clean, left, leaving: { ...a.node.membership.leaving! }, epoch: a.node.epoch }
  } finally {
    if (child) await stop(child)
    await a.destroy()
  }
}

test('the knock window over real sockets: the survivor is STOPPED for 1.2 s; the leaver keeps knocking, the survivor wakes inside the window, votes and echoes — destroy() resolves true, after the stall and inside the shell cap', async () => {
  const r = await stalledLeave({ leaveWindow: 30 })
  assert.equal(r.clean, true, `a clean stop (took ${r.took.toFixed(0)} ms; leaving ${JSON.stringify(r.leaving)})`)
  assert.deepEqual(r.left, [1], 'the kernel said so: `left` b=1')
  assert.equal(r.epoch, 2, 'the view without aa committed')
  assert.ok(r.took >= STALL - 50, `the vote could not come before the wake (${r.took.toFixed(0)} ms ≥ ${STALL})`)
  assert.ok(r.took < HB * (30 + 2), `inside the shell cap (${r.took.toFixed(0)} ms < ${HB * 32} ms)`)
  assert.equal(r.leaving.ticks, 0, 'no tick counted toward the four-tick bound: the survivor was linked throughout')
  assert.ok(r.leaving.total > 4, `the leaver ticked past the old bound (${r.leaving.total} ticks) and was still knocking`)
})

test('the window shut (leaveWindow at the bound, what leave.ms 0 means): the same stall, and the leaver gives up at the fifth tick while the survivor sleeps — destroy() resolves false before the wake, as before the window', async () => {
  const r = await stalledLeave({ leaveWindow: 4 })
  assert.equal(r.clean, false, `not a clean stop (took ${r.took.toFixed(0)} ms)`)
  assert.deepEqual(r.left, [0], 'the kernel said so: `left` b=0')
  assert.equal(r.epoch, 1, 'nothing committed: the survivor never voted in time')
  assert.ok(r.took < STALL, `gave up before the survivor woke (${r.took.toFixed(0)} ms < ${STALL} ms)`)
  assert.equal(r.leaving.total, 5, 'the fifth tick: the bound alone')
})
