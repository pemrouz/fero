//! ── 02 · a server and a client — terminal 2: the client ──
//
//   terminal 2:  node client.ts        (terminal 1 runs server.ts; start them in either order)
//
// Bare fero(name) is a CLIENT: it looks the name up in the box's directory and dials what it finds —
// no addresses, no config at all. One tap re-renders on every replicated change. Its own assignment is
// the same api: the write rides to the server, is stamped there, and echoes back to every watcher —
// this one included: a client shows its own write when the server's stamp comes back, not before.
// A sale is a FACT — one new row per event — never a read-modify-write of the seeded stock (two
// watchers doing that would lose sales to last-writer-wins; 17 shows it).

import { fero } from '../../api/index.ts'
import { coalesce, onExit, ticks } from '../lib.ts'
import { label, render } from './demo-ui.ts'

const inventory = await fero('inventory')                             //! bare = a client: zero config

const screen = coalesce(() => render(label('WATCHER', inventory), inventory.snapshot))
screen()
inventory.data.tap(screen)                                            //! one tap: re-render on every replicated change
inventory.cluster.tap(screen)                                         //! the label follows the directory: a restarted server has a NEW port

let n = 0
const timer = setInterval(() => {
  inventory.data[`sale-${Date.now().toString(36)}`] = { item: 'gadgets', qty: 1 }   //! a sale = a NEW row: relayed to the server, stamped there, echoed back — and only then shown here
  if (++n >= ticks()) { clearInterval(timer); setTimeout(() => void inventory.destroy(), 1000) }   //! bounded run: the last sale is on the wire — it shows only as its echo, so wait a beat for it to paint, then stop
}, 4000)

onExit(async () => { clearInterval(timer); await inventory.destroy() })
