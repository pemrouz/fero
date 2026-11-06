// P-07 streams and replay, as API.md §7 writes it, with `server: true` (C1). `savedCursor` and
// `save` are the app's (API.md's env.d.ts); here they are passed in. The loop stops after `n` (C10).
import { fero } from '../proto/index.ts'
type Cursor = string & { readonly __fero: 'cursor' }        // API.md's brand: a cursor kept as text needs a cast back (D12)

export const writer = async (k: string, ev: { type: string; cents: number }) => {
  const events = await fero('events', { server: true, rows: false, history: '7d' })
  await events.set(k, ev)
}
export const replay = async (savedCursor: Cursor | undefined, save: (c: Cursor) => void, n: number, seen: unknown[]) => {
  const events = await fero('events')
  const r = events.read({ from: savedCursor ?? 'earliest' })   // any kept position, or 'latest'
  for await (const e of r) {
    seen.push([e.partition, e.version, e.rec.value])
    save(r.cursor)                                             // a position never changes meaning
    if (--n <= 0) break
  }
}
