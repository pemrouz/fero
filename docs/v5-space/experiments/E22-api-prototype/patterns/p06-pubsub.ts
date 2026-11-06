// P-06 pub/sub, as API.md §7 writes it, with `server: true` (C1). The publisher and the subscriber
// are split into two functions so several subscribers can run; the caller ends a loop with close() (C10).
import { fero } from '../proto/index.ts'

export const open = (durability: 'none' | 'persisted' = 'none') =>
  fero('news', { server: true, rows: false, ...(durability === 'none' ? { durability } : {}) })   // none: no disk, no log, best effort
export const subscriber = async (got: unknown[]) => {
  const news = await fero('news')
  const sub = news.read({ partitions: ['sports'], from: 'latest' })
  void (async () => { for await (const e of sub) got.push(e.rec.value) })()
  return sub
}
export const publish = async (headline: string) => {
  const news = await fero('news')
  await news.set('sports', { headline })                                // the subject is the partition
}
