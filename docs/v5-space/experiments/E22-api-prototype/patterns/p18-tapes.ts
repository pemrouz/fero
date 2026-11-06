// P-18 tapes, forks, replays, as API.md §7 writes it. The fork is not built in the prototype (it
// throws 'config'); the check runs try.ts for that refusal and the test-run part for the rest.
import { fero } from '../proto/index.ts'
import { tape } from './lib/index.ts'

// ── try.ts, on the live cluster: a fork shares the parent's history
export const tryFork = async () => {
  await fero.fork('shop', { as: 'shop-try' })                  // one record per group, no copy
  const trial = await fero('shop-try', { server: true })
  await trial.set('widgets', { stock: 0 })                     // the parent never sees it
}

// ── a fero test run: one world per process, virtual time and ids, the shuffle on
export const testRun = async (seed: number) => {
  const w = fero.world({ seed })
  const shop = await fero('shop', { listen: false })           // a socketless solo node
  await shop.set('k', { at: fero.now() })
  await w.advance('1h')                                         // TTLs, leases and timers fire in order
  const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
  await stripe.record('charge:981', { cents: 1200 }, { ok: true })   // added: something to find
  const found = stripe.find('charge:981')
  const out = { k: shop.snapshot.k, found, id: fero.id(), now: fero.now() }
  await w.close()
  return out
}
