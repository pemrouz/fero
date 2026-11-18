// file: patterns.ts — the key lines of API.md's 22 patterns in the lens shape. Type-checked against lens.d.ts.
import { op, lock, queue, limiter, service, tape } from 'fero'
import { fero, saga, type Resource, type Commit } from 'fero-lens'
declare const el: { textContent: string }                      // a DOM node stand-in
declare const list: { rows: unknown }

{ // P-01 live shared state
  type Item = { stock: number }
  const shop = await fero('shop', { data: { widgets: { stock: 10 } } as Record<string, Item> })
  shop.data.tap((c) => console.log(c.value))                   // every commit; c.value by reference
  const client = await fero<Record<string, Item>>('shop')
  const ack = await client.data.gadgets.set({ stock: 4 })      // answered at its commit
  const w = client.data.gizmos.set({ stock: 7 }); await w.received   // a whole row: early stages
  await client.data.gadgets.stock.set(5).received
  client.data.gadgets.stok.set(5)
  client.data.gadgets.stock.set('five')
  console.log(ack.version, client.rows.widgets?.stock, client.data.widgets.stock.peek())
}
{ // P-02 cache with expiry
  await fero('cache', { server: true, rows: { ttl: '10m', max: 1e6 } })
  const cache = await fero<Record<string, { name?: string; n?: number }>>('cache', { hold: '50MB' })
  await cache.data['user:42'].set({ name: 'Ada' })
  await cache.data.hot.set({ n: 1 }, { ttl: '30s' })
  await cache.data['user:42'].touch()
}
{ // P-03 near cache, client data sync
  const users = await fero<Record<string, { name: string }>>('users', { hold: '200MB' })
  const u = await users.data.u42                               // a miss: one trip; nothing kept
  const mine = users.data.pick(['u42', 'u43']).here()          // held and live: the old follow
  await mine.ready
  const same = users.data.u42.peek()                           // here: one lookup
  const sure = await users.data.u42.get({ fresh: true })
  console.log(u, same, sure, mine.cursor)
}
{ // P-04 read-through cache
  const prices = await fero('prices', { rows: { ttl: '5m' }, load: (sku) => db.price(sku) })
  console.log(await prices.data['sku-1'])
}
{ // P-05 websocket fan-out by room: a room is a partition, a message a row
  type Msg = { text: string; at: number }
  await fero<Record<string, Record<string, Msg>>, {}, 2>('chat', { server: true, depth: 2, rows: { ttl: '1d' }, history: '1d' })
  const chat = await fero<Record<string, Record<string, Msg>>, {}, 2>('chat', { depth: 2, hold: '200MB' })
  wss.on('connection', (ws, room) => {
    chat.data[room].connect(ws)                                // the room so far, then each change; ends with ws
    ws.on('message', (text) => { chat.data[room][fero.id()].set({ text, at: fero.now() }) })
  })
}
{ // P-06 pub/sub
  await fero('news', { server: true, rows: false })
  const news = await fero<Record<string, { headline: string }>>('news', { hold: 'asked' })
  const sub = news.data.sports.changes()                       // from now on
  await news.data.sports.set({ headline: 'late winner' })
  for await (const e of sub) { console.log(e.value?.headline); break }
}
{ // P-07 streams and replay
  const events = await fero<Record<string, { type: string; cents: number }>>('events', { hold: 'asked' })
  const ack = await events.data['order:981'].set({ type: 'paid', cents: 1200 })
  const r = events.data.changes({ from: savedCursor ?? 'earliest', until: 'latest' })
  for await (const e of r) { console.log(e.partition, e.version, e.value); save(r.cursor) }
  events.data['order:981'].changes({ from: ack.version }).close()
}
{ // P-08 consumer groups
  const orders = await fero<Record<string, { cents: number }>>('orders', { hold: 'asked' })
  const invoices = await fero<Record<string, { order: unknown; at: number }>>('invoices', { hold: 'asked' })
  orders.data.changes({ as: 'invoicing' }).connect(invoices.data, (out, e) => out[e.partition].set({ order: e.value, at: e.time }))  // exactly once
  for await (const e of orders.data.changes({ as: 'billing' })) await bill(e.value)                // at least once
}
{ // P-09 work queue: the library keeps its shape
  const work = await queue<{ url: string }>('thumbs')
  work.work(async (job) => { await resize(job.url) })
}
{ // P-10 locks
  const ledger = await fero<Record<string, { by: number }>>('ledger', { hold: 'asked' })
  await lock('payroll', { lease: '10s', wait: '5s' }, async (l) => {
    await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })
  })
}
{ // P-11 counters and rate limits
  const views = await fero<Record<string, number>>('views', { hold: 'asked' })
  const a = await views.data['page:/'].set(op.incr(1))
  const api = await limiter('api', { max: 100, per: '1m' })
  console.log(a.value, (await api.take('user:42')).left)
}
{ // P-12 leaderboards: the plain-data operator runs on a server, its changes cross
  type Score = { player: string; points: number }
  const fan = await fero<Record<string, Score>>('scores', { hold: 'asked' })
  fan.data.za('points', 10).connect(list, 'rows')              // left of the boundary: on a server
  fan.data.za('points', 10).here().map((s) => s.player).connect(list, 'rows')   // map runs here
}
{ // P-13 presence
  await fero('online', { server: true, rows: { while: 'session' } })
  const online = await fero<Record<string, { since: number }>>('online')
  await online.data.ada.set({ since: fero.now() })
}
{ // P-14 invariants: a method on a path runs at that path's leader
  type Item = { left: number; price: number }
  const stock = await fero('stock', {
    data: {} as Record<string, Item>,
    methods: {
      sell: (_: void, ctx) => ctx.at.left.set(op.incr(-1, { min: 0 })),
      reprice: (price: number, ctx) => ctx.at.set((row: Item | undefined) => row && { ...row, price }),
    },
  })
  type Stock = typeof stock
  const client = await fero.as<Stock>('stock')
  await client.data.widgets.sell()                             // one trip, one commit
  await client.data.widgets.reprice(12)
  client.data.widgets.refund()
  client.data.widgets.reprice('twelve')
}
{ // P-15 a saga: a step's address is a lens
  const accounts = await fero<Record<string, { cents: number }>>('accounts', { hold: 'asked' })
  await saga([
    { at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) },
    { at: accounts.data.bob.cents, value: op.incr(5000) },
  ], { once: 'tx-981' })
}
{ // P-16 event sourcing
  type Fact = { account: string; cents: number }
  const facts = await fero<Record<string, Fact>>('facts', { hold: 'asked' })
  const balance = new Map<string, number>()
  for await (const e of facts.data.changes({ from: 'earliest', until: 'latest' }))
    if (e.value) balance.set(e.value.account, (balance.get(e.value.account) ?? 0) + e.value.cents)
}
{ // P-17 derived resources: a connect whose target is a resource
  type Order = { user: string; cents: number }
  const orders = await fero<Record<string, Order>>('orders', { hold: 'asked' })
  const totals = await fero<Record<string, number>>('totals', { server: true })
  orders.data.changes().connect(totals.data, (out, e) => { if (e.value) out[e.value.user].set(op.incr(e.value.cents)) })
}
{ // P-18 tapes, forks, replays; and a step back in time
  const shop = await fero<Record<string, { at: number }>>('shop')
  const ack = await shop.data.k.set({ at: fero.now() })
  const before = shop.data.k.asOf(ack.version).step(-1)        // the row just before that write
  const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
  console.log(await before, stripe.find('charge:981'))
}
{ // P-19 clients everywhere: a browser
  type Cart = Record<string, { n: number }>
  const shop = await fero.as<Resource<Record<string, Cart>, {}, 2>>('shop', { hosts: ['wss://shop.example.com'], token: 't', hold: '20MB' })
  shop.data.ada.connect(el, (node, c: Commit<Cart>) => { node.textContent = String(Object.keys(c.value ?? {}).length) })
}
{ // P-20 change the shape of rows: unchanged (fero.alter, migrate)
}
{ // P-21 request and reply: unchanged (service), or a method on a path
  const asker = await service<{ url: string }, { url: string }>('thumbs')
  console.log((await asker.ask({ url: 'a.png' }, { timeout: '5s' })).url)
}
{ // P-22 delayed jobs: unchanged (queue)
  const mail = await queue<{ to: string }>('mail')
  await mail.add({ to: 'ada' }, { delay: '15m' })
}
