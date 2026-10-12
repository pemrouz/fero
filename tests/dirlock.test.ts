//! Tier-3 real-WAL: the dir lock (wave 6b, DECISIONS V4-NN). One process at a time holds a `dir`. Before this a second
// process started on a dir the first still held restored it, ran as the same uuid, and both appended rows to one log
// (the platform spikes, 2026-10-12). Now the composer takes `lock` (pid, host, boot id, process start time; one atomic
// link) before it reads the boot record; a second open is refused at fero() time with a typed error naming the holder;
// a clean stop and the process exit release it; a lock left by a dead or reused pid, or from before a reboot, is taken
// over; a lock from another machine is never taken over. The two-process cases run real children through fero.spawn
// (tests/dirlock.child.ts); the container shapes run the child as pid 1 of its own pid namespace (unshare), skipped
// where the box has no user namespaces.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Runtime, lockDir } from '../shell/runtime.ts'
import { fero } from '../api/index.ts'
import { until } from '#utils'

const CHILD = path.join(import.meta.dirname, 'dirlock.child.ts')
const HOST = os.hostname()
const BOOT = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return null } })()
type Lock = { pid: number; host: string; boot: string | null; start: number | null }
const lockOf = (dir: string): Lock | null => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')) } catch { return null } }
const startOf = (pid: number): number => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]) }
const plant = (dir: string, l: Partial<Lock>, file = 'lock') => fs.writeFileSync(path.join(dir, file), JSON.stringify({ pid: 1, host: HOST, boot: BOOT, start: null, ...l }) + '\n')
//! deadPid — a pid nobody runs under on this box: from the top of Linux's range downward until kill(pid, 0) says ESRCH
const deadPid = (): number => {
  for (let pid = 4_194_303; pid > 1; pid--) { try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid } }
  throw new Error('no free pid')
}
const mine = (pid = process.pid): Lock => ({ pid, host: HOST, boot: BOOT, start: startOf(pid) })

test('one process, one dir: a second Runtime on a held dir is refused with code dir-held naming this process, under the same spelling or a symlinked one; destroy() releases the lock and the next open succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-')), link = dir + '-link'
  fs.symlinkSync(dir, link)
  let a: Runtime | null = null, b: Runtime | null = null
  try {
    a = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    assert.deepEqual(lockOf(dir), mine(), 'the lock names this process: pid, host, boot id, start time')
    const held = (e: Error & { code?: string; pid?: number; host?: string }) =>
      e.code === 'dir-held' && e.pid === process.pid && e.host === HOST && /is held by this process already \(pid \d+ on \S+\); one dir is one node/.test(e.message)
    assert.throws(() => new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir }), held, 'refused, typed, naming the holder')
    //! another spelling of the same dir (a symlink): the record is this process's own by its fields, not by the path it
    // was opened under — before this, the second spelling held the dir too, and its release deleted the lock the first ran on
    assert.throws(() => new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir: link }), held, 'refused under the symlinked spelling too')
    assert.deepEqual(lockOf(dir), mine(), 'the refusals left the lock as it was')
    await a.destroy()
    a = null
    assert.equal(lockOf(dir), null, 'a clean stop releases the lock')
    b = new Runtime({ uuid: 'aa', listen: '127.0.0.1:0', dir })
    assert.deepEqual(lockOf(dir), mine(), 'the next life holds it')
  } finally {
    await a?.destroy()
    await b?.destroy()
    fs.rmSync(link, { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the composer: fero() on a held dir rejects with the fero('name') prefix and the typed fields; the lock is taken BEFORE the boot record is read, and a refusal of the dir gives it back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-api-')), dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-api2-'))
  let f: Awaited<ReturnType<typeof fero>> | null = null
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    f = await fero('notes', { dir, listen: false })
    await assert.rejects(fero('notes', { dir, listen: false }), (e: Error & { code?: string; pid?: number }) => e.code === 'dir-held' && e.pid === process.pid && e.message.startsWith(`fero('notes'): dir ${dir} is held by this process already`))
    await f.destroy()
    f = null
    assert.equal(lockOf(dir), null)
    //! the order: with another process holding the dir, a dir whose boot record belongs to ANOTHER resource is refused
    // as held, not as the other resource's — the lock was taken before boot.json was read
    const holder = fero.spawn(CHILD, [dir2]); kids.push(holder) // the child opens its dir as 'locked'
    assert.ok(await until(() => holder.out.includes('up '), 20_000), `the holder never said up (${holder.out})`)
    await assert.rejects(fero('other', { dir: dir2, listen: false }), (e: Error & { code?: string; pid?: number }) => e.code === 'dir-held' && e.pid === holder.pid, 'held comes before the dir belonging to another resource')
    assert.equal(await holder.stop(), 0)
    //! a refusal of the dir itself (the boot record names another resource) releases the lock it took first
    await assert.rejects(fero('other', { dir: dir2, listen: false }), /this dir belongs to resource 'locked'/)
    assert.equal(lockOf(dir2), null, 'the refused open gave the lock back')
    f = await fero('locked', { dir: dir2, listen: false })
    assert.deepEqual(lockOf(dir2), mine(), 'and the right name holds it')
  } finally {
    await f?.destroy()
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  }
})

test('two processes on one dir (fero.spawn): the second is refused naming the first; the first stops cleanly on Ctrl-C and releases; a third starts in its place; a process that exits without a clean stop releases at exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-spawn-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    const first = fero.spawn(CHILD, [dir]); kids.push(first)
    assert.ok(await until(() => first.out.includes('up '), 20_000), `the first child never said up (${first.out})`)
    assert.deepEqual(lockOf(dir), mine(first.pid), "the lock names the first child's pid")
    const second = fero.spawn(CHILD, [dir]); kids.push(second)
    //! bounded: a shell without the lock lets the second child come UP and wait for Ctrl-C (the test must fail, not hang)
    assert.ok(await until(() => second.out.includes('refused') || second.out.includes('up '), 20_000), `the second child said nothing (${second.out})`)
    assert.equal(await Promise.race([second.exited, new Promise((r) => setTimeout(r, 2000, 'running'))]), 2, 'the second child was refused and exited 2')
    assert.ok(second.out.includes(`refused dir-held ${first.pid} ${HOST} fero('locked'): dir ${dir} is held by another process — pid ${first.pid} on ${HOST}`), `the refusal names the holder (${second.out})`)
    assert.deepEqual(lockOf(dir), mine(first.pid), 'the first still holds it')
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

test('a stale lock is taken over: a dead pid, a pid the kernel gave to another program since, this process\'s own pid from a life before, a boot id of this host that is not the running one; another machine\'s lock is refused and says to remove it by hand', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-stale-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  const takenOver = (l: Partial<Lock>, why: string) => {
    plant(dir, l)
    const release = lockDir(dir, 'test')
    assert.deepEqual(lockOf(dir), mine(), why)
    release()
    assert.equal(lockOf(dir), null)
  }
  const refused = (l: Partial<Lock>, re: RegExp, why: string) => {
    plant(dir, l)
    assert.throws(() => lockDir(dir, 'test'), (e: Error & { code?: string }) => e.code === 'dir-held' && re.test(e.message), why)
    fs.unlinkSync(path.join(dir, 'lock'))
  }
  try {
    const dead = deadPid()
    plant(dir, { pid: dead })
    const heir = fero.spawn(CHILD, [dir]); kids.push(heir)
    assert.ok(await until(() => heir.out.includes('up '), 20_000), `the heir never said up (${heir.out})`)
    assert.deepEqual(lockOf(dir), mine(heir.pid), 'a dead pid: the lock was taken over by the heir')
    assert.equal(await heir.stop(), 0)
    assert.equal(lockOf(dir), null)
    //! a lock from before this process (kill -9, then the kernel gave the same pid to the new node: a container restarts
    // its node as pid 1 again) names MY pid, and this process does not hold it: stale
    takenOver({ pid: process.pid, start: startOf(process.pid) - 1000 }, "my own pid from a life before this one")
    takenOver({ pid: process.pid }, 'my own pid with no start time (an older record)')
    //! a pid that is alive but started at another time is another program wearing the dead holder's pid
    takenOver({ pid: 1, start: startOf(1) + 7 }, 'pid 1 is alive, but its start time is not the record\'s')
    //! a boot id of this host that is not the running one: the box rebooted, nothing survives that
    if (BOOT !== null) takenOver({ pid: 1, boot: 'not-' + BOOT, start: startOf(1) }, 'a lock from before a reboot')
    //! a lock from before this change (pid and host only) is judged by pid and host
    plant(dir, { pid: dead }); fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: dead, host: HOST }) + '\n')
    lockDir(dir, 'test')(); assert.equal(lockOf(dir), null, 'a two-field record with a dead pid: stale')
    //! a stale takeover marker (an heir that crashed mid-takeover) is removed the same way
    plant(dir, { pid: dead }); plant(dir, { pid: dead }, 'lock.take')
    const release = lockDir(dir, 'test')
    assert.deepEqual(lockOf(dir), mine())
    assert.equal(fs.existsSync(path.join(dir, 'lock.take')), false, 'the marker is gone')
    release()
    //! live: pid 1 as it really is (another process on this kernel)
    refused({ pid: 1, start: startOf(1) }, /held by another process — pid 1 on /, 'init is alive and started when the record says')
    //! another machine: another host name with no boot id, or with another boot id — no pid check is possible
    refused({ pid: 1, host: 'elsewhere', boot: null }, /remove .*lock by hand once that machine is gone/, 'another host, no boot id')
    refused({ pid: 1, host: 'elsewhere', boot: 'some-other-kernel' }, /remove .*lock by hand/, 'another host, another kernel')
    //! another host name on THIS kernel is a recreated container on the same volume: the pid check applies
    if (BOOT !== null) takenOver({ pid: dead, host: 'c-old' }, 'the same kernel under a new host name, the pid dead: stale')
    //! an empty lock older than the grace is a writer that died between the create and the write: stale
    fs.writeFileSync(path.join(dir, 'lock'), '')
    fs.utimesSync(path.join(dir, 'lock'), Date.now() / 1000 - 60, Date.now() / 1000 - 60)
    const t0 = performance.now()
    lockDir(dir, 'test')()
    assert.ok(performance.now() - t0 < 1000, 'an old empty lock is stale at once')
    assert.equal(lockOf(dir), null)
  } finally {
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('two heirs at once after a crash: the takeover is one at a time — the second is refused naming the first, never both holding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-heirs-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    plant(dir, { pid: deadPid() })
    const a = fero.spawn(CHILD, [dir, 'take-slow']); kids.push(a)
    assert.ok(await until(() => a.out.includes('taking'), 20_000), `the first heir never entered the takeover (${a.out})`)
    const b = fero.spawn(CHILD, [dir, 'take-slow']); kids.push(b)
    assert.ok(await until(() => a.out.includes('up ') && (b.out.includes('refused') || b.out.includes('up ')), 20_000), `no answer (a: ${a.out} b: ${b.out})`)
    assert.ok(a.out.includes('up '), `the first heir holds the dir (${a.out})`)
    assert.ok(b.out.includes(`refused dir-held ${a.pid} ${HOST}`), `the second heir is refused, naming the first (${b.out})`)
    assert.equal(await b.exited, 2)
    assert.deepEqual(lockOf(dir), mine(a.pid))
    assert.equal(await a.stop(), 0)
    assert.equal(lockOf(dir), null)
  } finally {
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a filesystem without hard links: the lock falls back to the exclusive create and the write; a second opener that meets the empty file in that gap waits for the record and is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-nolink-'))
  const kids: ReturnType<typeof fero.spawn>[] = []
  try {
    const a = fero.spawn(CHILD, [dir, 'nolink']); kids.push(a)
    assert.ok(await until(() => a.out.includes('up '), 20_000), `the holder never said up (${a.out})`)
    assert.deepEqual(lockOf(dir), mine(a.pid), 'the fallback wrote the same record')
    const b = fero.spawn(CHILD, [dir]); kids.push(b)
    assert.ok(await until(() => b.out.includes('refused') || b.out.includes('up '), 20_000))
    assert.ok(b.out.includes(`refused dir-held ${a.pid} ${HOST}`), `refused naming the holder (${b.out})`)
    assert.equal(await a.stop(), 0)
    assert.equal(lockOf(dir), null, 'released the same way')
    //! the gap: the holder sits a second between the create and the write; the second opener meets an empty lock
    const c = fero.spawn(CHILD, [dir, 'nolink-slow']); kids.push(c)
    assert.ok(await until(() => c.out.includes('created-empty'), 20_000), `the slow holder never created the lock (${c.out})`)
    const d = fero.spawn(CHILD, [dir]); kids.push(d)
    assert.ok(await until(() => c.out.includes('up ') && (d.out.includes('refused') || d.out.includes('up ')), 20_000), `no answer (c: ${c.out} d: ${d.out})`)
    assert.ok(d.out.includes(`refused dir-held ${c.pid} ${HOST}`), `the second opener waited for the record and was refused (${d.out})`)
    assert.equal(await c.stop(), 0)
    assert.equal(lockOf(dir), null)
  } finally {
    for (const k of kids) await k.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

//! the container shapes: the node runs as pid 1 of its own pid namespace (docker, kubernetes, a Fly VM), is killed -9,
// and the same image restarts as pid 1 again on the same volume; or a recreate gives the new container a new host name
const NS = ['-Urpf', '--mount-proc'] // a user namespace with root mapped, a new pid namespace, fork, /proc of that namespace
const canUnshare = spawnSync('unshare', [...NS, 'true'], { stdio: 'ignore' }).status === 0
const inNs = (args: string[], hostname?: string): Promise<{ out: string; code: number | null }> => new Promise((resolve) => {
  const cmd = hostname !== undefined
    ? ['-Urpfu', '--mount-proc', 'sh', '-c', `hostname ${hostname}; exec "$0" "$@"`, process.execPath, ...args]
    : [...NS, process.execPath, ...args]
  const c = spawn('unshare', cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  let out = ''
  c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
  c.stderr.setEncoding('utf8').on('data', (d: string) => { out += d })
  c.on('close', (code) => resolve({ out, code }))
})
test('a container restart: the node is pid 1 of its namespace, killed -9, and pid 1 again in the next life — it takes its own stale lock over; a recreate under a new host name does too; a plain restart outside the namespace too', { skip: !canUnshare && 'no user namespaces here (unshare -Urpf failed)' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fero-lock-ns-'))
  try {
    const life1 = await inNs([CHILD, dir, 'crash'])
    assert.ok(life1.out.includes('up 1') && life1.code === 0, `life 1 ran as pid 1 and ended without releasing (${life1.out})`)
    assert.equal(lockOf(dir)?.pid, 1, 'the crash left its lock, naming pid 1')
    const life2 = await inNs([CHILD, dir, 'exit'])
    assert.ok(life2.out.includes('up 1') && life2.code === 0, `life 2, pid 1 again on the same volume, took the stale lock over (${life2.out})`)
    assert.equal(lockOf(dir), null, 'and released it at exit')
    //! the recreate: the next container has a new host name; the kernel is the same, so the pid check still applies
    const old = await inNs([CHILD, dir, 'crash'], 'c-old')
    assert.ok(old.out.includes('up 1'), `c-old ran as pid 1 and crashed (${old.out})`)
    assert.equal(lockOf(dir)?.host, 'c-old')
    const fresh = await inNs([CHILD, dir, 'exit'], 'c-new')
    assert.ok(fresh.out.includes('up 1') && fresh.code === 0, `c-new took c-old's stale lock over (${fresh.out})`)
    //! a plain restart outside any namespace: the box's own pid 1 is alive, but it is not the holder (its start time is not the record's)
    const crashed = await inNs([CHILD, dir, 'crash'])
    assert.ok(crashed.out.includes('up 1'), crashed.out)
    const plain = fero.spawn(CHILD, [dir, 'exit'])
    assert.ok(await until(() => plain.out.includes('up ') || plain.out.includes('refused'), 20_000), plain.out)
    assert.equal(await plain.exited, 0, `a restart outside the namespace took the lock over (${plain.out})`)
    assert.equal(lockOf(dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
