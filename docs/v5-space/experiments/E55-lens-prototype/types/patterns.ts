// file: patterns.ts — LENS.md section 2.10's `// lens` lines, verbatim, each in the context its pattern needs.
// Changes to a line are marked EDIT with the reason; a line that needs one is a finding.
import { fero, op, consumer, derive, saga, scope, group, type Resource, type Methods, type Ack, type Sel } from 'fero'

type Item = { stock: number; price?: number } // API.md P-01's row, with LENS 2.5's price
type User = { name: string; email: string }
type Order = { user: string; cents: number }
type Score = { player: string; points: number }
type Fan = Resource<Record<string, Score>, { top: (n: number, ctx: any) => Sel<Score> }, 1, 'client'>

async function p01(shop: Resource<Record<string, Item>>, client: Resource<Record<string, Item>, {}, 1, 'client'>) {
  shop.data.tap((c) => console.log(c.now.rows))                           // lens
  const ack = await client.data.gadgets.set({ stock: 4 })                 // lens
  const w = await client.data.widgets.get(); w?.stock                     // lens: one trip, nothing held
}
async function p02(cache: Resource<Record<string, { n: number }>>) {
  await cache.data.hot.set({ n: 1 }, { ttl: '30s' }); await cache.data['user:42'].touch()     // lens
}
async function p03(users: Resource<Record<string, User>, {}, 1, 'client'>) {
  const u = await users.data.u42.get()                                    // lens: read once, nothing kept
  const me = users.data.u42.here(); await me.ready; me.value              // lens: held and live, by choice
}
async function p04(prices: Resource<Record<string, { cents: number }>, {}, 1, 'client'>) {
  await prices.data['sku-1'].get()                                        // lens
}
async function p05(chat: Resource<any, {}, 2>) {
  await fero('chat', { server: true, depth: 2, rows: { ttl: '1d' }, history: '1d' })                     // lens
  chat.data[room].connect(ws, (ws, c) => ws.send(c.text()))               // one JSON text per commit per room; ends when ws closes
  chat.data[room][fero.id()].set({ text, at: fero.now() })
}
async function p06(news: Resource<Record<string, { headline: string }>>) {
  const sub = news.data.sports.changes(); await news.data.sports.set({ headline })            // lens
}
async function p07(events: Resource<Record<string, unknown>>, ack: Ack) {
  events.data.changes({ from: savedCursor ?? 'earliest', until: 'latest' })                   // lens
  events.data['order:981'].changes({ from: ack.version })
}
async function p08(invoicing: Awaited<ReturnType<typeof group<Order>>>, invoices: Resource<Record<string, { order: Order | undefined; at: number }>>, orders: Resource<Record<string, Order>>) {
  invoicing.run((e) => invoices.data[e.partition].set({ order: e.value, at: e.time }, { from: e }))           // lens: the mark is on the line
  for await (const batch of await consumer(orders, 'billing')) { /* … */ await batch.commit() }               // both: at least once
}
async function p10(ledger: Resource<Record<string, { by: number }>>) {
  await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })                   // lens
}
async function p11(views: Resource<Record<string, number>>) {
  const a = await views.data['page:/'].set(op.incr(1))                                        // lens
}
async function p12(fan: Fan) {
  const live = fan.methods.top(10).here(); live.tap((c) => render(c.now.rows))                // lens: the same served view
  fan.methods.top(10).here().map((s) => s.player).connect(board, 'rows')                      // lens: top on a server, map here
}
async function p13(online: Resource<Record<string, { since: number }>>) {
  const all = online.data.here(); await online.data.ada.set({ since: fero.now() })            // lens: "holds every row" is a line
}
async function p14() {
  const stock = await fero('stock', { data: {} as Record<string, { left: number }>, methods: {
    sell: { at: 'row', run: async (_: void, ctx) => (await ctx.at.left.set(op.incr(-1, { min: 0 }))).value },               // lens
  } })
  type Stock = typeof stock
  const client = await fero<Stock>('stock')
  await client.data.widgets.sell()                                        // lens: at widgets' leader; one trip, one commit
}
async function p15(accounts: Resource<Record<string, { cents: number }>>) {
  await saga([{ at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) }])          // lens: a step takes one lens
}
async function p16(facts: Resource<Record<string, unknown>>) {
  for await (const e of facts.data.changes({ from: 'earliest', until: 'latest' })) apply(e)   // lens
}
async function p17() {
  const orders = await fero<Order>('orders')                      // a client of the source
  const totals = await fero<number>('totals', { server: true })   // a server of the target
  await derive(orders, totals, (e) => { if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e }) })   // lens: the library, shown first
  for await (const e of orders.data.changes({ from: totals.marks('totals') }))                               // lens: what it is made of (1.7)
    if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })
}
async function p18(shop: Resource<Record<string, Item>>, ack: Ack) {
  await fero.fork('shop', { as: 'shop-try' })                             // both: unchanged
  const before = (await shop.data.k.asOf(ack.version)).step(-1)           // lens, new: the row just before that write's commit
}
async function p19(shop: Resource<Record<string, Record<string, Item>>, {}, 2, 'client'>) {
  shop.data.ada.connect(el, (el, c) => render(el, c.now.rows))            // lens: with depth 2 a cart is a partition
}
export {}
