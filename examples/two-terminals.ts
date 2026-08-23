//! ── the two-terminal demo (plan §11 M5): one resource, two processes, real sockets ──
//
//   terminal 1:  npm run demo -- serve
//   terminal 2:  npm run demo -- watch
//
// v4.1: zero addresses, zero identities, zero internals imports. The server is a server
// because it DECLARES an initial value (`data:` is a server marker — role by declared
// act); the watcher is bare fero(name) — a client by default, dialing the name-derived
// local port. Kill the server mid-run and restart it with the same command: the watcher
// redials, catches up over anti-entropy, and the tap resumes. Everything below is the
// public surface — `fero`, `data`, one tap.

import { fero, derivedAddr } from '../api/index.ts'

const mode = process.argv[2]
const addr = derivedAddr('inventory') // shown in the labels — derived from the NAME, configured nowhere

const render = (label: string, value: unknown) => {
  console.clear()
  console.log(`fero two-terminal demo — ${label}\n`)
  console.log(JSON.stringify(value, null, 2))
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
    if (tick % 5 === 0) f.data.gadgets.stock = 3 + (tick / 5) % 4
    render(`SERVER on ${addr} (tick ${tick})`, f.snapshot)
  }, 1000)
  render(`SERVER on ${addr} — waiting for watchers`, f.snapshot)
} else if (mode === 'watch') {
  const f = await fero('inventory')
  render(`WATCHER of ${addr} — connecting`, {})
  //! one tap: re-render on every replicated change — no polling, no events, no wire code
  f.data.tap(() => render(`WATCHER of ${addr}`, f.snapshot))
} else {
  console.log('usage: npm run demo -- serve | watch')
  process.exit(1)
}
