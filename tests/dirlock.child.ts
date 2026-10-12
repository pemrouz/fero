//! tests/dirlock.child — a role file for the dir lock's spawn cases (tests/dirlock.test.ts): `node dirlock.child.ts
// <dir> [exit]` opens the named dir as a socketless durable node, prints `up <pid>` and waits for the parent's Ctrl-C
// (fero.spawn's stop(): the clean stop, V4-8), or with `exit` ends at once through process.exit (the exit hook releases
// the lock); refused, it prints `refused <code> <pid> <host> <message>` and exits 2. Not a test file (the battery's glob
// is tests/*.test.ts).

import { fero } from '../api/index.ts'

const [dir, mode] = process.argv.slice(2)
try {
  await fero('locked', { dir, listen: false })
  console.log(`up ${process.pid}`)
  if (mode === 'exit') process.exit(0)
} catch (e) {
  const err = e as Error & { code?: string; pid?: number; host?: string }
  console.log(`refused ${err.code} ${err.pid} ${err.host} ${err.message}`)
  process.exit(2)
}
