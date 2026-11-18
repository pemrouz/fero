import { fero, op } from 'fero'
import { lens } from 'fero-space'
type Msg = { text: string; stars: number; by: string }
type Chat = Record<string, Record<string, Msg>>            // keys: 2 — room, then message
declare const ul: { append(x: string): void }
const chat = lens<Chat>(await fero('chat'))

const one = await chat.data.room1.m7                       // read once: one trip, nothing kept
const room = chat.data.room1.last(50).here()               // the server keeps "last 50"; this process mirrors it
const mine = room.filter((m) => m.by === 'me')             // runs here
const link = chat.data.room1.last(50).connect(ul, (el, c) => { for (const d of c.rows) if (d.type === 'add') el.append(d.row.text) })
chat.data.room1.m9.set({ text: 'hi', stars: 0, by: 'me' })
chat.data.room1.m9.stars.set(op.incr(1))
// @ts-expect-error a closure cannot run before here(): code does not travel
chat.data.room1.filter((m: Msg) => m.stars > 0)
link.close(); room.close()
console.log(one?.text, mine.rows)

// derive as a pattern: a reader, a server, a mark on each write
type Order = { user: string; cents: number }
const orders = lens<Record<string, Order>>(await fero('orders'))
const totals = lens<Record<string, number>>(await fero('totals', { server: true }))
for await (const e of orders.data.changes({ from: totals.marks('totals') }))
  if (e.value) totals.data[e.value.user]!.set(op.incr(e.value.cents), { from: e })
