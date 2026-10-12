//! tests/dirlock.child — a role file for the dir lock's spawn cases (tests/dirlock.test.ts): `node dirlock.child.ts
// <dir> [mode]` opens the named dir as a socketless durable node, prints `up <pid>` and waits for the parent's Ctrl-C
// (fero.spawn's stop(): the clean stop, V4-8). Refused, it prints `refused <code> <pid> <host> <message>` and exits 2.
// The modes shape the life: `exit` ends at once through process.exit (the exit hook releases the lock); `crash` ends
// without any exit hook, so the lock stays as after a kill -9; `take-slow` holds the takeover of a stale lock open for three
// seconds between the look and the unlink, and prints `taking` as it enters that window (two heirs at once); `nolink`
// runs on a filesystem without hard links (linkSync refused), and `nolink-slow` on top sits one second between the
// create of the empty lock and the write of its record (the gap a second opener may meet there). Not a test file (the
// battery's glob is tests/*.test.ts).

import fs from 'node:fs'
import { fero } from '../api/index.ts'

const [dir, mode] = process.argv.slice(2)
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
if (mode === 'take-slow') {
  const unlink = fs.unlinkSync
  fs.unlinkSync = (p) => { if (String(p).endsWith('/lock')) { console.log('taking'); nap(3000) } return unlink(p) }
}
if (mode === 'nolink' || mode === 'nolink-slow') {
  fs.linkSync = () => { throw Object.assign(new Error('ENOTSUP: no hard links here'), { code: 'ENOTSUP' }) }
  if (mode === 'nolink-slow') {
    const open = fs.openSync
    fs.openSync = ((p: fs.PathLike, flags?: fs.OpenMode, m?: fs.Mode) => { const fd = open(p, flags, m); if (String(p).endsWith('/lock') && flags === 'wx') { console.log('created-empty'); nap(1000) } return fd }) as typeof fs.openSync
  }
}
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
