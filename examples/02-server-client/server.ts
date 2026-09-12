//! ── 02 · a server and a client — terminal 1: the server ──
//
//   terminal 1:  node server.ts
//   terminal 2:  node client.ts        (either order: a client waits for the name to appear)
//   prove it:    node check.ts
//
// `data:` is a server marker — role by declared act: a seed makes a server. It binds a free loopback
// port and registers with the box's directory; it never names an address or an identity. The seed is
// whole ROWS, and from here on this file writes whole rows too — one write style per subtree. (A leaf
// write like `widgets.stock = 7` on a seeded row is the overlapping-cells footgun: after a memory-only
// restart the server re-seeds the row while a watcher's resync deletes the stale leaf from its copy,
// so the watcher's row loses the field and the two disagree until the next whole-row write.) The
// watcher's sales arrive as FACT rows, one per sale, and this screen counts them live. In these two
// files only this one rewrites the seeded rows — but the server is OPEN (no `methods:`), so any
// process on the box could; the README's limits say so.

import { fero } from '../../api/index.ts'
import { coalesce, onExit, ticks } from '../lib.ts'
import { label, render } from './demo-ui.ts'

const inventory = await fero('inventory', {
  data: {                                                              //! the seed: whole rows, applied once to an empty resource
    widgets: { stock: 10, price: 4.5 },
    gadgets: { stock: 3, price: 19.99 },
  },
})
const sales = inventory.data.filter((r) => r.item !== undefined).length()   //! a LIVE count of the sale rows — a scalar view; .snapshot() reads it

let tick = 0
const screen = coalesce(() => {                                       //! one screen for data AND cluster changes, drawn once per turn
  const watchers = Object.keys(inventory.cluster.snapshot().peers).length
  render(`${label('SERVER', inventory)} (tick ${tick}, watchers ${watchers}, sales ${sales.snapshot()})`, inventory.snapshot)
})
screen()
inventory.data.tap(screen)                                            //! a sale shows the instant it lands
inventory.cluster.tap(screen)                                         //! a watcher arriving or leaving shows too

const timer = setInterval(() => {
  tick++
  inventory.data.widgets = { ...inventory.snapshot.widgets, stock: 10 + Math.round(Math.sin(tick / 3) * 5) }   //! the WHOLE row, in the seed's style
  if (tick >= ticks()) { clearInterval(timer); void inventory.destroy() }   //! FERO_EXAMPLE_TICKS bounds a run (a check sets it); unset = forever
}, 1000)

onExit(async () => { clearInterval(timer); await inventory.destroy() })     //! Ctrl-C = a clean stop; the watcher will re-find the next server
