//! ── terminal 2: the client ──
// Bare fero(name) is a client: it looks the name up in the box's directory and dials what it
// finds. One tap re-renders on every replicated change. Its own assignment is the same API:
// the write rides to the server, is stamped there, and echoes back to every watcher.
import { fero } from '../api/index.ts'
import { render, label } from './demo-ui.ts'

const inventory = await fero('inventory')

render(label('WATCHER', inventory), {})
inventory.data.tap(() => render(label('WATCHER', inventory), inventory.snapshot))
inventory.cluster.tap(() => render(label('WATCHER', inventory), inventory.snapshot))

setInterval(() => {
  const stock = inventory.snapshot?.gadgets?.stock
  if (typeof stock !== 'number') return
  inventory.data.gadgets.stock = stock > 0 ? stock - 1 : 5
}, 4000)
