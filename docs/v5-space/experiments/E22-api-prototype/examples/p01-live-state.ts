// P-01 live shared state, as API.md §7 writes it. API.md has two files; here each is a function
// that a simulated process runs (proc.run), so fero() resolves in that process.
import { fero } from '../proto/index.ts'
type Item = { stock: number }

// ── server.ts
export const server = async (print: (x: unknown) => void = console.log) => {
  const shop = await fero<Item>('shop', { data: { widgets: { stock: 10 } } })   // a seed makes a server
  shop.data.tap(() => print(shop.snapshot))                                       // every commit, live
  return shop
}

// ── client.ts: a bare name is a client; it follows the whole resource
export const client = async (print: (...x: unknown[]) => void = console.log) => {
  const client = await fero<Item>('shop')
  client.data.gadgets = { stock: 3 }                      // fire and forget: it shows when it commits (V4-7)
  const ack = await client.set('gadgets', { stock: 4 })   // the same write, with an answer after commit
  const w = client.snapshot.widgets                       // a sync read of a held row: a property read
  print(ack.version, w.stock)
  return { client, ack, w }
}
