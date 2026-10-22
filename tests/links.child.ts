//! tests/links.child — a role file for the run batch's exit cases (tests/links.test.ts): `node links.child.ts <host:port>
// [count] [run|listener]` dials the given address with a bare Runtime (heartbeats off, so it sends nothing of its own
// after its HELLO), prints `up`, and waits for one line on stdin. Then, in ONE run:
// - run (the default): it ships `count` PINGs (1 by default) on its link and calls process.exit(0). The last batch of
//   PINGs is still in the socket when the process exits, and only the shell's 'exit' hook can flush it.
// - listener: it ships nothing, registers a process 'exit' listener of its own that ships the `count` PINGs, and calls
//   process.exit(0). That listener runs after the shell's exit hook (the shell registers it when it loads), so a cork
//   made in it would never open: its PINGs must go out uncorked.
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
    const ship = () => { for (let i = 0; i < Number(process.argv[3] ?? 1); i++) rt.node.env.sink.send(link, ping) }
    if (process.argv[4] === 'listener') process.on('exit', ship)
    else ship()
    process.exit(0)
  })
}, 5)
