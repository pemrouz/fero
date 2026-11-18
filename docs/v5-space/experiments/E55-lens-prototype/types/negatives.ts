// file: negatives.ts — LENS.md claim 5's lines that must NOT compile. Each @ts-expect-error fails the check if its
// line ever compiles; run.sh also strips them and checks that each one errors for the reason given.
import { fero, op, type Resource } from 'fero'

type Item = { stock: number; price?: number }
type Msg = { text: string; stars: number }
async function negatives(shop: Resource<Record<string, Item>>, chat: Resource<Record<string, Record<string, Msg>>, {}, 2>) {
  // @ts-expect-error 1. a wrong field
  await shop.data.widgets.stok.set(4)
  // @ts-expect-error 2. a wrong value type
  await shop.data.widgets.stock.set('four')
  // @ts-expect-error 3. an early stage on a field write (it can be refused 'absent-row')
  await shop.data.widgets.stock.set(4).received
  // @ts-expect-error 4. a function left of here(): code cannot travel
  chat.data.room1.filter((m: Msg) => m.stars > 0).here()
  chat.data.room1.here().filter((m) => m.stars > 0)              // right of here(): compiles
  chat.data.room1.gt('stars', 0).za('stars', 10).here()          // plain data left of here(): compiles
  // 5. set on the typed client of a resource with methods (V4-5)
  const stock = await fero('stock', { data: {} as Record<string, { left: number }>, methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.left.set(op.incr(-n, { min: 0 })) },
  } })
  await stock.data.widgets.left.set(4)                           // the server writes: compiles
  type Stock = typeof stock
  const client = await fero<Stock>('stock')
  await client.data.widgets.sell(1)                              // the method on a path: compiles
  // @ts-expect-error 5. the typed client of a resource with methods has no set
  await client.data.widgets.left.set(4)
  // @ts-expect-error 5b. nor remove
  await client.data.widgets.remove()
  // @ts-expect-error 5c. nor the array form
  await client.set(['widgets', 'left'], 4)
  // review F8: a method is offered only where its author declared it ('row' here)
  // @ts-expect-error 6. a row method below the row
  await client.data.widgets.left.sell(1)
  // @ts-expect-error 6b. a row method at the root
  await client.methods.sell(1)
  // review F3: a lens is not a promise: `await lens` is the lens, not the value
  // @ts-expect-error 7. await lens does not read
  const n: number | undefined = await stock.data.widgets.left
  const m: number | undefined = await stock.data.widgets.left.get()   // the read: compiles
  // extra: a method's argument is checked on a path too
  // @ts-expect-error a method's argument type
  await client.data.widgets.sell('one')
}
export {}
