// file: screens.ts — LENS.md's other code blocks (2.0, 2.2, 2.4, 2.5, 2.9, 1.1, 1.2, 1.6, 1.7), verbatim where
// they stand alone. Each block is a function; a needed edit is marked EDIT.
import { fero, op, scope, type Resource, type Methods, type Ctx } from 'fero'

type Item = { stock: number; price: number }
// the server of 2.0 and 1.3: a seed and methods (1.3 elides them; 2.0 calls `sell` on a path)
const shopServer = await fero('shop', { data: { widgets: { stock: 10, price: 5 } } as Record<string, Item>, methods: {
  sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },
} })
type Shop = typeof shopServer

async function s20(notes: Resource<Record<string, { title: string }>>, views: Resource<Record<string, number>>) {
  const shop = await fero<Shop>('shop')                    // a client. It holds nothing yet
  const stock = shop.data.widgets.stock                    // steps: an address. No trip, no read. Not a promise
  const n = await stock.get()                              // read once: here if held on purpose, else one trip. Keeps nothing
  await shop.data.widgets.sell(1)                          // a method on a path: runs at widgets' leader
  const live = shop.data.widgets.here()                    // hold it here, live: one SUB (the old follow)
  await live.ready
  live.value?.stock                                        // a sync read of what is held: one lookup
  shop.data.widgets.stock.connect(el, 'textContent')       // el.textContent is kept up to date; ends with el, close() or the scope
  // writes: on a server, or on a client of a resource with no methods (V4-5: methods are the door)
  await notes.data.n1.title.set('hi')                      // a write: one trip, one commit (V4-7: it shows when it commits)
  await views.data['page:/'].set(op.incr(1))               // the leader computes it
  // the first form of this screen wrote through the typed client of a resource WITH methods; 2.4 says that
  // client has no set, and it does not compile (E-55 finding 5):
  // @ts-expect-error V4-5: the typed client of a resource with methods has no set
  await stock.set(4)
}
async function s22(chat: Resource<Record<string, Record<string, { text: string }>>, {}, 2>) {
  const room = chat.data.room1.here()                       // hold room1, live. Counted; shared with every other here() on room1
  await room.ready
  room.rows.m7                                              // sync reads go through the handle
  room.close()
  chat.data.room1.connect(listEl, (el, c) => { for (const ch of c.changes) patch(el, ch) })
  chat.data.room1.m7.text.connect(label, 'textContent')     // sets label.textContent now and at each commit
  chat.data.room1.connect(ws, (ws, c) => ws.send(c.text())) // c.text(): one JSON text per commit, shared by every socket in the room
  const page = scope(() => { /* every here() and connect made inside ends at page.dispose() */ })
}
async function s24() {
  type Item = { left: number }
  const stock = await fero('stock', {
    data: {} as Record<string, Item>,
    methods: {
      sell: { at: 'row', run: (n: number, ctx) => ctx.at.left.set(op.incr(-n, { min: 0 })) },   // ctx.at: the row the call was made on
      low:  (max: number, ctx) => ctx.data.lt('left', max),                                     // a bare function: the root only. Returns a view
    },
  })
  type Stock = typeof stock
  const client = await fero<Stock>('stock')
  await client.data.widgets.sell(1)          // goes straight to the leader of widgets' partition: one trip, one commit
  const low = client.methods.low(5).here()   // no path: any server
}
async function s25(shop: Resource<Record<string, Item>>) {
  const w = shop.data.gizmos.set({ stock: 7, price: 9 })      // a whole row: a handle with early stages (V5-11)
  await w.received
  await shop.data.widgets.stock.set(4)                        // a field: answers at its commit
  await shop.data.gizmos.set(row, { if: { absent: true } })   // a condition
  await shop.data.widgets.set((w) => w && { ...w, price: 12 })
  await shop.data.gizmos.remove()
  await shop.set([sku, 'stock'], 4)                           // the array spelling of the same write
}
async function s29(shop: Resource<Record<string, Item>>) {
  const past = await shop.data.widgets.asOf(cursor)   // a partition, as it was. Or a version, or a writer time (V5-4). Read-only. Folded here
  past.value                                           // the row as it was: about 1 µs
  past.step(-1); past.step(+1)                         // one commit back, one forward: a number changes
  past.seek(otherCursor)                               // a jump: a number changes
  past.close()
  const all = await shop.data.asOf(cursor)             // the whole resource as it was: every partition is folded. Costly; see below
  all.lt('stock', 5)                                   // data's operators work on it; they run here
}
async function s11(chat: Resource<Record<string, Record<string, { text: string; at: number }>>, {}, 2>) {
  await fero('users', { server: true })              // depth 1 (default): users.data.u42 is a row, and its own partition
  await fero('chat',  { server: true, depth: 2 })    // chat.data.room1 is a partition; chat.data.room1.m7 is a row
  chat.data[room][fero.id()].set({ text, at: fero.now() })   // a row write. No key string to build or split
  chat.data.room1.here()                                     // one partition, held live
}
async function s12(views: Resource<Record<string, number>>, orders: Resource<Record<string, { id: string }>>, totals: Resource<Record<string, number>>, e: import('fero').Entry<{ user: string; cents: number }>, id: string, order: { id: string }) {
  await views.data['page:/'].set(op.incr(1))                           // 1. sessions: a resend never counts twice. Nothing to write
  await orders.data[id].set(order, { once: 'import-7:row-3' })         // 2. a name: safe to send again from any process, for a day
  if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // 3. a mark. EDIT: `e.value` may be undefined: guarded
}
async function s16(view: Resource<Record<string, Item>>) {
  view.data.tap((c) => {
    c.first                         // true once: `changes` is then the picture so far
    for (const ch of c.changes)     // this commit's changes, by reference: ch.type, ch.key, ch.row, ch.prev
      patch(ch.key, ch.row, ch.prev)
    c.now                           // the latest state: the view itself. A lookup, not a copy
  })
}
export {}
