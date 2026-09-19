//! Tier-3: fero.spawn (V4-9) over REAL processes — the reader's other terminal, from code. Every child
// here is a whole script written to a temp dir: what a reader's `node server.ts` or `node check.ts` is.
process.env.FERO_RENDEZVOUS ??= 'off'

import { test, after } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fero, type Spawned } from './index.ts'
import { snapshot } from './substrate.ts'
import { ports, until } from '#utils'

const INDEX = JSON.stringify(path.join(import.meta.dirname, 'index.ts'))
const dirs: string[] = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })
const script = (name: string, src: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-spawn-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, name), src)
  return path.join(dir, name)
}
//! gone — no such process, or a zombie nobody has reaped yet (an orphan's reaper is whoever inherits it)
const gone = (pid: number) => until(() => {
  try { process.kill(pid, 0) } catch { return true }
  try { return /State:\s+Z/.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) } catch { return false }
}, 5000)
const kill = (...pids: (number | Spawned)[]) => { for (const p of pids) { try { process.kill(typeof p === 'number' ? p : p.pid, 'SIGKILL') } catch {} } }

test("fero.spawn runs `node <file>`: out is what it printed, stop() is the reader's Ctrl-C — and a second SIGINT 20 ms in (the terminal's group delivery) does not cut the leave short: the member leaves by ballot and exits 0, the survivor is alone and writable", async () => {
  const [pa, pb] = [await ports.free(), await ports.free()]
  const member = script('member.ts', `import { fero } from ${INDEX}
await fero('sp', { uuid: 'aa', listen: '127.0.0.1:${pa}', hosts: ['127.0.0.1:${pb}'], rendezvous: false, heartbeatMs: 50, redialMs: 30 })
console.log('up', process.pid)
setInterval(() => {}, 1000)
`)
  const child = fero.spawn(member)
  const b = await fero('sp', { uuid: 'bb', listen: `127.0.0.1:${pb}`, hosts: [`127.0.0.1:${pa}`], rendezvous: false, heartbeatMs: 50, redialMs: 30 })
  const view = () => snapshot(b.cluster) as { epoch: number; writable: boolean; members: Record<string, string> }
  try {
    assert.ok(await until(() => child.out.includes(`up ${child.pid}`), 10_000), "stdout is captured on the handle, and pid is the child's")
    assert.ok(await until(() => view().epoch >= 1 && Object.keys(view().members).length === 2, 10_000), 'the pair formed')
    const stopped = child.stop()
    setTimeout(() => { try { process.kill(child.pid, 'SIGINT') } catch {} }, 20)   //! the tty's copy of the same Ctrl-C
    assert.equal(await stopped, 0, 'stop() resolved the clean exit code: the second signal joined the leave')
    assert.ok(await until(() => Object.keys(view().members).length === 1 && view().writable, 5000), `the survivor is alone and writable (${JSON.stringify(view())})`)
    assert.equal(await child.stop(), 0, 'a second stop() answers the same')
  } finally {
    kill(child)
    await b.destroy()
  }
})

test('stop() gives up: a child that ignores SIGINT is SIGKILLed after five seconds and stop() resolves null — a broken clean stop fails a check instead of hanging it; the signal listener leaves with the last child', async () => {
  const stuck = script('stuck.ts', "process.on('SIGINT', () => {})\nconsole.log('stuck')\nsetInterval(() => {}, 1000)\n")
  const listeners = process.listenerCount('SIGINT')
  const child = fero.spawn(stuck)
  try {
    assert.equal(process.listenerCount('SIGINT'), listeners + 1, 'a spawned child installs the one listener')
    assert.ok(await until(() => child.out.includes('stuck'), 10_000), 'the child is up')
    const t0 = Date.now()
    assert.equal(await child.stop(), null, 'null: the grace ran out')
    const ms = Date.now() - t0
    assert.ok(ms >= 4900 && ms < 9000, `the five-second grace (${ms} ms)`)
    assert.equal(child.child.signalCode, 'SIGKILL', 'ended by SIGKILL')
    assert.equal(process.listenerCount('SIGINT'), listeners, 'the listener is gone with the last child')
  } finally {
    kill(child)
  }
})

test("a parent's Ctrl-C stops the children it spawned, waits for their own stop, and exits 0; a parent that dies on a thrown error takes them with it; the echo names the file and the pid, and out is stdout only", async () => {
  const idle = script('idle.ts', `console.log('hello')
console.error('oops')
process.on('SIGINT', () => setTimeout(() => { console.log('bye'); process.exit(0) }, 300))
setInterval(() => {}, 1000)
`)
  const parent = script('parent.ts', `import { fero } from ${INDEX}
const c = fero.spawn(${JSON.stringify(idle)})
console.log('child', c.pid)
await new Promise((r) => setTimeout(r, 300))
if (process.argv[2] === 'throw') throw new Error('boom')
setInterval(() => {}, 1000)
`)
  const childOf = (p: Spawned) => Number(/child (\d+)/.exec(p.out)?.[1] ?? -1)
  const p1 = fero.spawn(parent)
  const p2 = fero.spawn(parent, ['throw'])
  try {
    //! Ctrl-C to the parent ALONE (not the terminal's group): it stops its child, waits, and exits 0
    assert.ok(await until(() => childOf(p1) > 0 && p1.out.includes('] hello'), 10_000), 'the parent echoed the child')
    assert.ok(p1.out.includes(`[idle ${childOf(p1)}] hello`), `the echo is prefixed with the file and the pid (${p1.out})`)
    assert.ok(!p1.out.includes('oops'), 'stderr is echoed to stderr and never lands in out')
    assert.equal(await p1.stop(), 0, 'the parent exited 0 on SIGINT: nothing of its own listens, so fero exits for it')
    assert.ok(p1.out.includes(`[idle ${childOf(p1)}] bye`), "the parent WAITED for its child's own stop before exiting")
    assert.ok(await gone(childOf(p1)), 'the grandchild is gone: the parent stopped it before exiting')
    //! a thrown error: the parent dies with code 1 and its exit hook SIGKILLs the child
    assert.equal(await p2.exited, 1, 'the parent died on the throw')
    assert.ok(childOf(p2) > 0, 'its output is complete once exited resolves')
    assert.ok(await gone(childOf(p2)), 'the grandchild is gone: a dying parent takes its children')
  } finally {
    kill(p1, p2, childOf(p1), childOf(p2))
  }
})
