//! ── the two-terminal demo (plan §11 M5): one resource, two processes, real sockets ──
//
//   terminal 1:  npm run demo -- serve 4800
//   terminal 2:  npm run demo -- watch 4800
//
// The server seeds a tiny inventory and mutates it once a second. The watcher is a
// CLIENT (hosts, no listen): it folds the same replicated state and re-renders on
// every change through a plain reactive tap — no polling, no events, no wire code.
// Kill the server mid-run and restart it with the same command: the watcher redials,
// catches up over anti-entropy, and the tap resumes. Everything below is the public
// surface — `fero`, `data`, one tap.

import { fero } from '../api/index.ts'
import { snapshot } from '../api/substrate.ts'

const [mode, port = '4800'] = process.argv.slice(2)
const addr = `127.0.0.1:${port}`

const render = (label: string, value: unknown) => {
  console.clear()
  console.log(`fero two-terminal demo — ${label}\n`)
  console.log(JSON.stringify(value, null, 2))
}

if (mode === 'serve') {
  const f = await fero('inventory', { uuid: 'server', listen: addr })
  f.data.widgets = { stock: 10, price: 4.5 }
  f.data.gadgets = { stock: 3, price: 19.99 }
  let tick = 0
  setInterval(() => {
    tick++
    //! ordinary assignments ARE the replication api
    f.data.widgets.stock = 10 + Math.round(Math.sin(tick / 3) * 5)
    if (tick % 5 === 0) f.data.gadgets.stock = 3 + (tick / 5) % 4
    render(`SERVER on ${addr} (tick ${tick})`, snapshot(f.data))
  }, 1000)
  render(`SERVER on ${addr} — waiting for watchers`, snapshot(f.data))
} else if (mode === 'watch') {
  const f = await fero('inventory', { uuid: 'watcher-' + process.pid, hosts: [addr] })
  render(`WATCHER of ${addr} — connecting`, {})
  //! one tap: re-render on every replicated change (the bare 0-arg form — no record bookkeeping)
  f.data.tap(() => render(`WATCHER of ${addr}`, snapshot(f.data)))
} else {
  console.log('usage: npm run demo -- serve [port] | watch [port]')
  process.exit(1)
}
