//! Tier-3 real-WAL: the dir lock (wave 6b, DECISIONS V4-NN). One process at a time holds a `dir`. Before this a second
// process started on a dir the first still held restored it, ran as the same uuid, and both appended rows to one log
// (the platform spikes, 2026-10-12). Now the shell takes `lock` (pid + host, O_EXCL) before the WAL opens; a second
// open is refused at fero() time with a typed error naming the holder; a clean stop and the process exit release it; a
// lock left by a dead pid is taken over; a lock from another host is never taken over. The two-process cases run real
// children through fero.spawn (tests/dirlock.child.ts).

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime, lockDir } from '../shell/runtime.ts'
import { fero } from '../api/index.ts'
import { until } from '#utils'

const CHILD = path.join(import.meta.dirname, 'dirlock.child.ts')
const lockOf = (dir: string): { pid: number; host: string } | null => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')) } catch { return null } }
//! deadPid — a pid nobody runs under on this box: from the top of Linux's range downward until kill(pid, 0) says ESRCH
const deadPid = (): number => {
  for (let pid = 4_194_303; pid > 1; pid--) { try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid } }
  throw new Error('no free pid')
}

test('one process, one dir: a second Runtime on a held dir is refused with code dir-held naming this pid and host; destroy() releases the lock and the next open succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-'))
  let a: Runtime | null = null, b: Runtime | null = null
  try {
    a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    assert.deepEqual(lockOf(dir), { pid: process.pid, host: os.hostname() }, 'the lock names this process')
    assert.throws(() => new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir }), (e: Error & { code?: string; pid?: number; host?: string }) =>
      e.code === 'dir-held' && e.pid === process.pid && e.host === os.hostname() && /is held by another process — pid \d+ on \S+; one dir is one node/.test(e.message), 'refused, typed, naming the holder')
    assert.deepEqual(lockOf(dir), { pid: process.pid, host: os.hostname() }, 'the refusal left the lock as it was')
    await a.destroy()
    a = null
    assert.equal(lockOf(dir), null, 'a clean stop releases the lock')
    b = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    assert.deepEqual(lockOf(dir), { pid: process.pid, host: os.hostname() }, 'the next life holds it')
  } finally {
    await a?.destroy()
    await b?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the composer's refusal: fero() on a held dir rejects with the fero('name') prefix and the typed fields", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-api-'))
  let f: Awaited<ReturnType<typeof fero>> | null = null
  try {
    f = await fero('notes', { dir, listen: false })
    await assert.rejects(fero('notes', { dir, listen: false }), (e: Error & { code?: string; pid?: number }) => e.code === 'dir-held' && e.pid === process.pid && e.message.startsWith(`fero('notes'): dir ${dir} is held by another process`))
    await f.destroy()
    f = null
    assert.equal(lockOf(dir), null)
  } finally {
    await f?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('two processes on one dir (fero.spawn): the second is refused naming the first; the first stops cleanly on Ctrl-C and releases; a third starts in its place; a process that exits without a clean stop releases at exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-spawn-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    const first = fero.spawn(CHILD, [dir]); kids.push(first)
    assert.ok(await until(() => first.out.includes('up '), 20_000), `the first child never said up (${first.out})`)
    assert.deepEqual(lockOf(dir), { pid: first.pid, host: os.hostname() }, "the lock names the first child's pid")
    const second = fero.spawn(CHILD, [dir]); kids.push(second)
    //! bounded: a shell without the lock lets the second child come UP and wait for Ctrl-C (the test must fail, not hang)
    assert.ok(await until(() => second.out.includes('refused') || second.out.includes('up '), 20_000), `the second child said nothing (${second.out})`)
    assert.equal(await Promise.race([second.exited, new Promise((r) => setTimeout(r, 2000, 'running'))]), 2, 'the second child was refused and exited 2')
    assert.ok(second.out.includes(`refused dir-held ${first.pid} ${os.hostname()} fero('locked'): dir ${dir} is held by another process — pid ${first.pid} on ${os.hostname()}`), `the refusal names the holder (${second.out})`)
    assert.deepEqual(lockOf(dir), { pid: first.pid, host: os.hostname() }, 'the first still holds it')
    assert.equal(await first.stop(), 0, 'the first stops cleanly on Ctrl-C')
    assert.equal(lockOf(dir), null, 'and released the lock')
    //! the third restores the dir (wal.log, boot.json and the lock file beside them) and holds it
    const third = fero.spawn(CHILD, [dir, 'exit']); kids.push(third)
    assert.ok(await until(() => third.out.includes('up '), 20_000), `the third child never said up (${third.out})`)
    assert.equal(await third.exited, 0)
    assert.equal(lockOf(dir), null, 'process.exit without a clean stop: the exit hook released it')
  } finally {
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left by a dead pid on this host is taken over (a crashed holder); one from another host is refused and says to remove it by hand', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-stale-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    const dead = deadPid()
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: dead, host: os.hostname() }) + '\n')
    const heir = fero.spawn(CHILD, [dir]); kids.push(heir)
    assert.ok(await until(() => heir.out.includes('up '), 20_000), `the heir never said up (${heir.out})`)
    assert.deepEqual(lockOf(dir), { pid: heir.pid, host: os.hostname() }, 'the stale lock was taken over')
    assert.equal(await heir.stop(), 0)
    assert.equal(lockOf(dir), null)
    //! a stale takeover marker (an heir that crashed mid-takeover) is removed the same way
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: dead, host: os.hostname() }) + '\n')
    fs.writeFileSync(path.join(dir, 'lock.take'), JSON.stringify({ pid: dead, host: os.hostname() }) + '\n')
    const release = lockDir(dir, 'test')
    assert.deepEqual(lockOf(dir), { pid: process.pid, host: os.hostname() })
    assert.equal(fs.existsSync(path.join(dir, 'lock.take')), false, 'the marker is gone')
    release()
    assert.equal(lockOf(dir), null)
    //! another host: no pid check is possible, so the lock counts as held
    fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: 1, host: 'elsewhere' }) + '\n')
    assert.throws(() => lockDir(dir, 'test'), (e: Error & { code?: string; host?: string }) => e.code === 'dir-held' && e.host === 'elsewhere' && e.message.includes('remove ' + path.join(dir, 'lock') + ' by hand'))
    //! an unreadable lock (a writer that died between the create and the write) is stale
    fs.writeFileSync(path.join(dir, 'lock'), '')
    lockDir(dir, 'test')()
    assert.equal(lockOf(dir), null)
  } finally {
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
