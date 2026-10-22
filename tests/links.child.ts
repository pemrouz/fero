//! tests/links.child — a role file for the run batch's exit case (tests/links.test.ts): `node links.child.ts <host:port>
// [count]` dials the given address with a bare Runtime (heartbeats off, so it sends nothing of its own after its HELLO),
// prints `up`, and waits for one line on stdin. Then, in ONE run, it ships `count` PINGs (1 by default) on its link and
// calls process.exit(0): the last batch of PINGs is still in the socket when the process exits, and only the shell's
// 'exit' hook can flush it.
// Not a test file (the battery's glob is tests/*.test.ts).

import '../utils/battery.ts'

import { Runtime } from '../shell/runtime.ts'
import { VERB, encodeControl } from '../kernel/codec.ts'

const rt = new Runtime({ uuid: 'cc', hosts: [process.argv[2]], heartbeatMs: 0, redialMs: 50 })
await rt.start()
const wait = setInterval(() => {
  if (rt.node.links.size === 0) return
  clearInterval(wait)
  console.log('up')
  process.stdin.once('data', () => {
    const [link] = rt.node.links.keys()
    const ping = encodeControl(VERB.PING)
    for (let i = 0; i < Number(process.argv[3] ?? 1); i++) rt.node.env.sink.send(link, ping)
    process.exit(0)
  })
}, 5)
