//! ── terminal 2: the client ──
// Bare fero(name) is a client: it looks the name up in the box's directory and dials what it
// finds. One tap re-renders on every replicated change. Its own assignment is the same API:
// the write rides to the server, is stamped there, and echoes back to every watcher.
import { fero } from '../api/index.ts'
import { render, label } from './demo-ui.ts'

const f = await fero('inventory')

render(label('WATCHER', f), {})
f.data.tap(() => render(label('WATCHER', f), f.snapshot))
f.cluster.tap(() => render(label('WATCHER', f), f.snapshot))

setInterval(() => {
  const stock = f.snapshot?.gadgets?.stock
  if (typeof stock !== 'number') return
  f.data.gadgets.stock = stock > 0 ? stock - 1 : 5
}, 4000)
