//! tests/knock.child — the knock window's survivor, in its own process so the test can STOP it (SIGSTOP) and wake it
// (SIGCONT): `node knock.child.ts <listen> <peer> <heartbeatMs>` runs one shell Runtime that dials the peer and prints
// `ready` once it listens. A stopped process is the real stall DESIGN-LEAVE §10.7 is about: its socket keeps the
// frames, its timers wait, and it reads everything at once when it wakes. The parent kills it when the test is done.
// Not a test file (the battery's glob is tests/*.test.ts).

import '../utils/battery.ts'
import { Runtime } from '../shell/runtime.ts'

const [listen, peer, hb] = process.argv.slice(2)
const rt = new Runtime({ uuid: 'bb', listen, hosts: [peer], heartbeatMs: Number(hb), redialMs: 30 })
await rt.start()
console.log('ready')
