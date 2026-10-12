//! tests/dirlock.child — a role file for the dir lock's spawn cases (tests/dirlock.test.ts): `node dirlock.child.ts
// <dir> [mode]` opens the named dir as a socketless durable node, prints `up <pid>` and waits for the parent's Ctrl-C
// (fero.spawn's stop(): the clean stop, V4-8). Refused, it prints `refused <code> <pid> <host> <message>` and exits 2.
// The modes shape the life: `exit` ends at once through process.exit (the exit hook releases the lock); `crash` ends
// without any exit hook, so the lock stays as after a kill -9; `take-slow` holds the takeover of a stale lock open for three
// seconds between the look and the unlink, and prints `taking` as it enters that window (two heirs at once); `marker-slow`
// sits 2.5 seconds between its look at a stale takeover marker and its removal, printing `pausing`; `slow-put` sits three
// seconds at the moment it puts its record in place, printing `putting`; `look-slow` sits three seconds after its first
// look at a stale lock, printing `looked` (all three below); `nolink`
// runs on a filesystem without hard links (linkSync refused), and `nolink-slow` on top sits one second between the
// create of the empty lock and the write of its record (the gap a second opener may meet there); `touch` opens nothing:
// it plays a holder in another pid namespace, touching the dir's `lock` every 100 ms until Ctrl-C (the lease). Not a
// test file (the battery's glob is tests/*.test.ts).

import fs from 'node:fs'
import path from 'node:path'
import { fero } from '../api/index.ts'

const [dir, mode] = process.argv.slice(2)
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
if (mode === 'touch') {
  const p = path.join(dir, 'lock')
  setInterval(() => { const now = Date.now() / 1000; try { fs.utimesSync(p, now, now) } catch { /* planted later, or gone */ } }, 100)
  process.on('SIGINT', () => process.exit(0))
  console.log('touching')
}
if (mode === 'take-slow') {
  const unlink = fs.unlinkSync
  fs.unlinkSync = (p) => { if (String(p).endsWith('/lock')) { console.log('taking'); nap(3000) } return unlink(p) }
}
//! `marker-slow`: an heir that meets a STALE takeover marker and sits 2.5 s between its look at it and its removal (the
// rename), printing `pausing` as it enters that window — another heir removes the stale marker and claims its own meanwhile
if (mode === 'marker-slow') {
  const rename = fs.renameSync, unlink = fs.unlinkSync
  let first = true
  const pause = (p: fs.PathLike) => { if (String(p).endsWith('/lock.take') && first) { first = false; console.log('pausing'); nap(2500) } }
  fs.renameSync = (a, b) => { pause(a); return rename(a, b) }
  fs.unlinkSync = (p) => { pause(p); return unlink(p) }
}
//! `slow-put`: sits 3 s at the moment this process puts its record in place — before the hard link (the shipped path),
// or between the exclusive create and the write (the fallback) — printing `putting`: a second opener starts in that window
if (mode === 'slow-put') {
  const link = fs.linkSync, open = fs.openSync
  fs.linkSync = ((a: fs.PathLike, b: fs.PathLike) => { if (String(b).endsWith('/lock')) { console.log('putting'); nap(3000) } return link(a, b) }) as typeof fs.linkSync
  fs.openSync = ((p: fs.PathLike, flags?: fs.OpenMode, m?: fs.Mode) => { const fd = open(p, flags, m); if (String(p).endsWith('/lock') && flags === 'wx') { console.log('putting'); nap(3000) } return fd }) as typeof fs.openSync
}
//! `look-slow`: sits 3 s after its FIRST look at a stale lock, before it claims the takeover marker, printing `looked`:
// another heir completes its takeover in that window, and the look again under the marker must see the fresh record
if (mode === 'look-slow') {
  const read = fs.readFileSync
  let first = true
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, o?: unknown) => { const r = read(p, o as BufferEncoding); if (first && String(p).endsWith('/lock')) { first = false; console.log('looked'); nap(3000) } return r }) as typeof fs.readFileSync
}
if (mode === 'nolink' || mode === 'nolink-slow') {
  fs.linkSync = () => { throw Object.assign(new Error('ENOTSUP: no hard links here'), { code: 'ENOTSUP' }) }
  if (mode === 'nolink-slow') {
    const open = fs.openSync
    fs.openSync = ((p: fs.PathLike, flags?: fs.OpenMode, m?: fs.Mode) => { const fd = open(p, flags, m); if (String(p).endsWith('/lock') && flags === 'wx') { console.log('created-empty'); nap(1000) } return fd }) as typeof fs.openSync
  }
}
if (mode !== 'touch') {
  try {
    await fero('locked', { dir, listen: false })
    console.log(`up ${process.pid}`)
    if (mode === 'exit') process.exit(0)
    //! a crash leaves the lock: no exit hook runs (pid 1 of a namespace ignores a SIGKILL it sends itself, so not kill -9)
    if (mode === 'crash') { process.removeAllListeners('exit'); process.exit(0) }
  } catch (e) {
    const err = e as Error & { code?: string; pid?: number; host?: string }
    console.log(`refused ${err.code} ${err.pid} ${err.host} ${err.message}`)
    process.exit(2)
  }
}
