// file: forms.ts — the owner's forms that must compile (E-56 probes, item 5). Each `Expect<Equal<…>>` line pins a
// type: if it were wrong, the line would not compile.
import { fero, type Link, type ThenableLink, type Commit, type Rows, type Version, type Lens } from './fero.js'
import type { Shop, Widget } from './server.js'
import { useEffect } from './react.js'

type Equal<X, Y> = (<Q>() => Q extends X ? 1 : 2) extends (<Q>() => Q extends Y ? 1 : 2) ? true : false
type Expect<T extends true> = T

const shopA = fero<Shop, 'a'>('shop') // V-a: the handle is thenable
const shop = fero<Shop>('shop') // V-b (the default): no then; get() reads once
declare const sku: string, v: Version, ws: WebSocket, ac: AbortController
declare function draw(w: Readonly<Widget>): void
declare function save(t: string): void

// F1 connect(fn): the state and the commit, once per commit
const h1 = shop.data.w1.connect((w, c) => { draw(w); if (!c.first) save(c.text()) })
type _f1 = Expect<Equal<typeof h1, Link<Readonly<Widget>, Widget>>>
// F2 connect(opts): a handle to read or to loop over
const h2 = shop.data.connect({ signal: ac.signal })
type _f2 = Expect<Equal<typeof h2.state, Rows<Widget>>>
// F3 connect(fn, opts): every option
shop.data.w1.connect(draw, { until: ws, signal: ac.signal, once: true, from: 'now' })
// F4 for await over connect({ from }): every commit from a position, typed
async function f4() {
  for await (const { state, commit } of shop.data.connect({ from: v })) {
    type _s = Expect<Equal<typeof state, Rows<Widget>>>
    type _c = Expect<Equal<typeof commit, Commit<Widget>>>
    for (const d of commit.diff) if (d.op === 'update') save(`${d.key} ${d.prev?.stock} -> ${d.row?.stock} at ${d.version}`)
  }
}
// F5 await connect(...) in V-a: the first state. The handle is gone, so this link can never be ended.
async function f5() {
  const w = await shopA.data.w1.connect()
  type _w = Expect<Equal<typeof w, Readonly<Widget>>>
  // the same through a helper: its return type is the state, not the handle (TypeScript unwraps the thenable)
  async function open() { return shopA.data.w1.connect(draw) }
  type _o = Expect<Equal<Awaited<ReturnType<typeof open>>, Readonly<Widget>>>
  // and through Promise.all
  const all = await Promise.all([shopA.data.w1.connect(draw), shopA.data.w2.connect(draw)])
  type _a = Expect<Equal<typeof all, [Readonly<Widget>, Readonly<Widget>]>>
  // a V-a handle kept in a variable is still a handle
  const kept = shopA.data.w1.connect(draw)
  type _k = Expect<Equal<typeof kept, ThenableLink<Readonly<Widget>, Widget>>>
  kept.disconnect()
}
// F6 get() in V-b: read once
async function f6() {
  const w = await shop.data.w1.get()
  type _w = Expect<Equal<typeof w, Readonly<Widget>>>
  const n = await shop.data.w1.stock.get({ signal: ac.signal })
  type _n = Expect<Equal<typeof n, number>>
}
// F7 get(key), the step by a key from input, next to get(), the read
async function f7() {
  const l = shop.data.get(sku) // a lens (an address): no read
  type _l = Expect<Equal<typeof l, Lens<Widget, Widget, 'row', 'b'>>>
  const w = await shop.data.get(sku).get() // "get, get": a step, then a read
  type _w = Expect<Equal<typeof w, Readonly<Widget>>>
  const n = await shop.data.get(sku).get('stock').get() // three gets: two steps, one read
  type _n = Expect<Equal<typeof n, number>>
  await shop.data.get(sku).set({ name: 'x', stock: 1, tags: [] }) // get/set: a step, then a write
  // today's spelling of the same step
  const t = await shop.at(sku).get()
  type _t = Expect<Equal<typeof t, Readonly<Widget>>>
}
// F8 the trap that COMPILES: `await` on get(key) gives the lens back, and printing it prints an address
async function f8() {
  const row = await shop.data.get(sku) // reads like Map.get: it is a step, and await does nothing here
  console.log(row.stock) // compiles; prints a lens, not a number
  JSON.stringify(row) // compiles
}
// F9 a framework cleanup takes the bound disconnect
useEffect(() => shop.data.w1.connect(draw).disconnect, [])
// F10 ready, then a sync read
async function f10() { const h = shop.data.w1.connect(); await h.ready; draw(h.state); h.close() }
// F11 one name by arity, with a key typed `any` (JSON.parse, an untyped request's params): the types take it as the
// step, a lens. At run time the call must then decide by the count of arguments, not by the key's value, and refuse an
// undefined key: deciding by value would turn a missing key into a read of the whole resource
async function f11(body: any) {
  const x = shop.data.get(body.sku)
  type _x = Expect<Equal<typeof x, Lens<Widget, Widget, 'row', 'b'>>>
}
void f4; void f5; void f6; void f7; void f8; void f10; void f11; void h2
