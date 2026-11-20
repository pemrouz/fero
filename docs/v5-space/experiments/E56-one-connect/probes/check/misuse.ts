// file: misuse.ts — lines that must NOT compile (E-56 probes, item 5). Each is the line right after its
// ts-expect-error comment; strip.mjs removes the comments and shows that tsc reports an error at each line.
import { fero } from './fero.js'
import type { Shop, Widget } from './server.js'
import { useEffect } from './react.js'

const shopA = fero<Shop, 'a'>('shop')
const shop = fero<Shop>('shop')
declare const sku: string, ac: AbortController, el: HTMLElement
declare function draw(w: Readonly<Widget>): void

async function overloads() {
  // @ts-expect-error M1 a string first: E-55's connect(target, 'prop') form is gone
  shop.data.w1.connect('textContent')
  // @ts-expect-error M2 two functions
  shop.data.w1.connect(draw, draw)
  // @ts-expect-error M3 the options first, then the function
  shop.data.w1.connect({ once: true }, draw)
  // @ts-expect-error M4 a position that is not one
  shop.data.connect({ from: 'yesterday' })
  // @ts-expect-error M5 until on a thing that cannot say it closed: a DOM element
  shop.data.w1.connect(draw, { until: el })
  // @ts-expect-error M6 until on a signal: a signal goes in signal
  shop.data.w1.connect(draw, { until: ac.signal })
}

async function thenable() {
  async function open() { return shopA.data.w1.connect(draw) }
  // @ts-expect-error M7 V-a: the helper's caller got the state, so there is nothing to disconnect
  ;(await open()).disconnect()
  // @ts-expect-error M8 V-a: `const h = await lens.connect(fn)` is the state, not the handle
  const h = await shopA.data.w1.connect(draw); h.disconnect()
  // @ts-expect-error M9 V-a: Promise.all resolved the handles away
  const [a] = await Promise.all([shopA.data.w1.connect(draw)]); a.disconnect()
}

async function notThenable() {
  // @ts-expect-error M10 V-b: awaiting the handle gives the handle; it has no stock
  const s = (await shop.data.w1.connect()).stock
  // @ts-expect-error M11 V-b: the handle is not the row
  const w: Widget = await shop.data.w1.connect()
  // @ts-expect-error M12 V-b: the handle has no then
  shop.data.w1.connect(draw).then(draw)
  // @ts-expect-error M13 a for-await turn is { state, commit }, not the row
  for await (const t of shop.data.w1.connect()) draw(t.stock)
  void s; void w
}

async function getKey() {
  // @ts-expect-error M14 get(key) reads like Map.get, but it is a step: the awaited lens is not a number
  if ((await shop.data.get(sku)).stock > 0) draw(await shop.data.get(sku).get())
  // @ts-expect-error M15 the same: a lens is not the row
  const w: Widget = await shop.data.get(sku)
  // @ts-expect-error M16 get(key) below a row takes the row's field names only
  shop.data.w1.get('stok')
  void w
}

// @ts-expect-error M17 a framework cleanup: returning the handle, not its disconnect
useEffect(() => shop.data.w1.connect(draw), [])

void overloads; void thenable; void notThenable; void getKey
