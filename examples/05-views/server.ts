import { fero } from '../../api/index.ts'

// four rows on a shelf, and six live views over them: each prints itself once, then again when a write moves a row across its edge or rewrites a row it holds
const f = await fero('shelf', { data: { nail: { cat: 'tool', price: 2 }, glue: { cat: 'art', price: 6 }, saw: { cat: 'tool', price: 25 }, kite: { cat: 'toy', price: 30 } } })
const views = {
    prices: f.data.map((r) => r.price),
    cheap: f.data.lt('price', 5),
    pricey: f.data.gt('price', 20),
    cats: f.data.distinct((r) => r.cat),
    count: f.data.length((r) => r.cat),
    cheapTools: f.data.lt('price', 5).intersect(f.data.filter((r) => r.cat === 'tool')),
}
f.data.tap((c) => console.log(`${c.key[0] ?? 'shelf'} =`, c.value))
for (const [name, view] of Object.entries(views)) view.tap(() => console.log(' ' + name, view.snapshot()))

// two whole-row rewrites: the saw goes on sale, the kite moves to the art aisle
f.data.saw = { cat: 'tool', price: 4 }
f.data.kite = { cat: 'art', price: 30 }
await f.destroy()
