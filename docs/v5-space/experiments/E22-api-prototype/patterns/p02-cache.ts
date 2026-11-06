// P-02 cache with expiry, session store, as API.md §7 writes it. Two changes, both API-NOTES:
// `server: true` (a resource key is not a server marker, C1), and the session row is written before
// it is touched (API.md touches 'sid-9f2', which nobody wrote: `touch` answers 'absent-row', D9).
import { fero } from '../proto/index.ts'

export const p02 = async () => {
  const cache = await fero('cache', { server: true, rows: { ttl: '10m', max: 1e6 } })   // the writer expires and evicts
  await cache.set('user:42', { name: 'Ada' })
  await cache.set('hot', { n: 1 }, { ttl: '30s' })                        // this row's own ttl
  const sessions = await fero('sessions', { server: true, rows: { ttl: '30m' } })
  await sessions.set('sid-9f2', { user: 42 })                             // added: a row to touch
  await sessions.touch('sid-9f2')                                          // resets the ttl, keeps the value
  return { cache, sessions }
}
