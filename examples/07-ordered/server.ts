import { fero } from '../../api/index.ts'

// object rows, in the order they arrive: an ordered view of them is an ARRAY in rank order
const f = await fero('parts', { data: { w1: { name: 'cog', price: 3 }, w2: { name: 'nut', price: 1 }, w3: { name: 'gear', price: 5 }, w4: { name: 'bolt', price: 3 } } })
const row = (r) => `${r.name} ${r.price}`

console.log('az price       ', f.data.az('price').snapshot().map(row))
console.log('az price, name ', f.data.az((a, b) => a.price - b.price || a.name.localeCompare(b.name)).snapshot().map(row))
console.log('limit 2        ', f.data.limit(2).snapshot().map(row))
console.log('reverse        ', f.data.reverse().snapshot().map(row))

// a bounded window: the tap prints it now, and once more when a whole-row rewrite rotates it
const top2 = f.data.za('price', 2)
top2.tap(() => console.log('za price 2     ', top2.snapshot().map(row)))
f.data.w2 = { name: 'nut', price: 9 }

// numeric rows are what top(n) is for
const s = await fero('scores', { data: { ada: 91, bob: 78, cy: 85 } })
console.log('top 2          ', s.data.top(2).snapshot())

await f.destroy()
await s.destroy()
