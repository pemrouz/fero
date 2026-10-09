//! tests/door.child — a role file for the door's spawn case: `node door.child.ts <name> <host:port>` follows the
// named resource at that address as a CLIENT with whatever the environment carries (FERO_SECRET, with FERO_CONFIG
// deleted by the parent so the layer is on), writes one row named after its pid, prints `up`, and waits for the
// parent's Ctrl-C (fero.spawn's stop(): the clean leave, V4-8). Not a test file (the battery's glob is tests/*.test.ts).

import { fero } from '../api/index.ts'

const [name, addr] = process.argv.slice(2)
const f = await fero(name, { hosts: [addr], heartbeat: { ms: 50 }, redial: { ms: 30 } })
f.data[`child-${process.pid}`] = 'joined'
console.log('up')
