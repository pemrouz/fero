//! ── terminal 1: the server ──
// `data:` is a server marker — role by declared act. The server binds a free loopback port and
// registers it with the box's directory; it never names an address or an identity.
import { fero } from '../api/index.ts'
import { render, label } from './demo-ui.ts'

const inventory = await fero('inventory', {
  data: {
    widgets: { stock: 10, price: 4.5 },
    gadgets: { stock: 3, price: 19.99 },
  },
})

let tick = 0
setInterval(() => {
  tick++
  inventory.data.widgets.stock = 10 + Math.round(Math.sin(tick / 3) * 5)
  render(`${label('SERVER', inventory)} (tick ${tick})`, inventory.snapshot)
}, 1000)

render(`${label('SERVER', inventory)} — waiting for watchers`, inventory.snapshot)
