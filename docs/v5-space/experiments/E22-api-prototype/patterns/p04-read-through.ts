// P-04 read-through cache over another system, as API.md §7 writes it. `db` is the app's own
// (API.md's env.d.ts); here it is passed in, so the check can give a slow stand-in.
import { fero } from '../proto/index.ts'
type Db = { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }

export const server = (db: Db) => fero('prices', {
  rows: { ttl: '5m' },
  load: (sku: string) => db.price(sku),    // runs at the writer, once per key however many miss
})
export const reader = async (print: (x: unknown) => void = console.log) => {
  const prices = await fero('prices')
  const p = await prices.get('sku-1')        // a miss waits for the one load; a write meanwhile wins
  print(p)
  return p
}
