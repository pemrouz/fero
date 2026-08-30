//! ── the two-terminal demo (plan §11 M5): one resource, two processes, real sockets ──
//
//   terminal 1:  npm run demo -- serve
//   terminal 2:  npm run demo -- watch
//
// V4-3: zero addresses, zero identities, zero internals imports — and zero hashing. The server is a
// server because it DECLARES an initial value (`data:` is a server marker — role by declared act);
// it binds a free loopback port and registers it with the box's directory (the `#directory` system
// resource at the rendezvous address, hosted by the first server on the box). The watcher is bare
// fero(name) — a client by default — and looks the name up live. Kill the server mid-run and
// restart it with the same command: it gets a NEW port, the directory says so, the watcher redials,
// catches up over anti-entropy, and the tap resumes. Run a second `serve` in a third terminal: the
// two servers find each other the same way and form a cluster. Everything below is the public
// surface — `fero`, `data`, `cluster.me`, one tap.

import { fero } from '../api/index.ts'

const mode = process.argv[2]

const render = (label: string, value: unknown) => {
  console.clear()
  console.log(`fero two-terminal demo — ${label}\n`)
  console.log(JSON.stringify(value, null, 2))
}

//! where am I, and who do I know: the listen the OS chose, the directory, the discovered peers —
// all on cluster.me; `.snapshot()` is the public sync read of any view
type Me = { listen: string; hosts: string[]; rendezvous: false | { addr: string; hosting: boolean; up: boolean } }
const label = (role: string, f: { cluster: any }) => {
  const me = f.cluster.me.snapshot() as Me
  const rz = me.rendezvous === false ? 'no directory' : `directory ${me.rendezvous.addr}${me.rendezvous.hosting ? ' (hosting)' : ''}${me.rendezvous.up ? '' : ' (down)'}`
  return `${role}${me.listen ? ` on ${me.listen}` : ''} — ${rz} — peers ${JSON.stringify(me.hosts)}`
}

if (mode === 'serve') {
  const f = await fero('inventory', {
    //! the initial value: seeds only a fresh resource, and marks this node the SERVER
    data: {
      widgets: { stock: 10, price: 4.5 },
      gadgets: { stock: 3, price: 19.99 },
    },
  })
  let tick = 0
  setInterval(() => {
    tick++
    //! ordinary assignments ARE the replication api
    f.data.widgets.stock = 10 + Math.round(Math.sin(tick / 3) * 5)
    render(`${label('SERVER', f)} (tick ${tick})`, f.snapshot)
  }, 1000)
  render(`${label('SERVER', f)} — waiting for watchers`, f.snapshot)
} else if (mode === 'watch') {
  const f = await fero('inventory')
  render(label('WATCHER', f), {})
  //! one tap: re-render on every replicated change — no polling, no events, no wire code
  f.data.tap(() => render(label('WATCHER', f), f.snapshot))
  //! and one more on the cluster: the label follows the directory (a restarted server has a new port)
  f.cluster.tap(() => render(label('WATCHER', f), f.snapshot))
} else {
  console.log('usage: npm run demo -- serve | watch')
  process.exit(1)
}
