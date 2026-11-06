// P-19's check (REQUIREMENTS P-19), on what the prototype has: a near-cache client follows a key
// prefix and holds exactly the rows under it, then their changes, and never the others. Not
// modelled: WebSocket, TLS, the door, the token's claims, the bundle size, the cold-start time.
import { check, report, isMain, servers, fero, sleep } from './common.ts'
import { p19 } from '../p19-clients.ts'

export const run = () => check('p19-clients', async (c) => {
  const [s1] = await servers(c, 3, () => fero('shop', { server: true }))
  const shop = await s1.fero('shop')
  for (const k of ['ada:cart', 'ada:prefs', 'bob:cart', 'cy:cart']) await shop.set(k, { k, n: 0 })
  await c.settle()
  const token = s1.run(() => fero.token({ sub: 'ada', follow: ['ada*'] }))
  c.chaos({ leaderChanges: 1, moves: 1, within: 20 })
  const seen: unknown[] = []
  const b = c.procs('browser')[0]
  const r = await b.run(() => p19(token, (x) => seen.push(x)))
  c.eq(Object.keys(r.cart.snapshot()).sort(), ['ada:cart', 'ada:prefs'], 'the follow holds exactly the prefix')
  for (let i = 1; i <= 3; i++) { await shop.set('ada:cart', { k: 'ada:cart', n: i }); await shop.set('bob:cart', { k: 'bob:cart', n: i }); await sleep(1) }
  await shop.set('ada:new', { k: 'ada:new', n: 0 })
  await c.w.advance('2s')
  c.eq(r.cart.snapshot()['ada:cart'], { k: 'ada:cart', n: 3 }, 'then its changes')
  c.eq(r.cart.snapshot()['ada:new'], { k: 'ada:new', n: 0 }, 'and new rows under the prefix')
  const held = [...(c.stack.l3.replicaIf(b, 'shop')!.held?.keys() ?? [])]
  c.ok(!held.some((p) => !p.startsWith('ada')), `the client holds nothing outside its prefix (${held})`)
}, { seeds: 40 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
