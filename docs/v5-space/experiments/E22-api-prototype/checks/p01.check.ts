// P-01's check: three servers, two clients running the example at once, under a leader change that
// may lose an uncommitted tail and one slot move. Order per partition, read-your-writes, every
// replica equal to the fold of the committed log (the harness's monitor), the seed applied once.
import { check, report, isMain } from '../proto/check.ts'
import { fero } from '../proto/index.ts'
import { server, client } from '../examples/p01-live-state.ts'

export const run = () => check('p01-live-state', async (c) => {
  const [s1, s2, s3, a, b] = c.procs('s1', 's2', 's3', 'a', 'b')
  let taps = 0
  const shop = await s1.run(() => server(() => taps++))
  await s2.run(() => server(() => {}))                  // a second seed does nothing: the resource exists
  await s3.run(() => fero('shop', { server: true }))
  await c.settle()
  c.chaos({ leaderChanges: 2, moves: 1, within: 3 })   // inside the clients' few ms of work
  const quiet = () => {}
  const [ra, rb] = await Promise.all([a.run(() => client(quiet)), b.run(() => client(quiet))])
  for (const r of [ra, rb]) {
    c.eq(r.w, { stock: 10 }, 'the seed row, read sync on a client')
    c.ok(typeof r.ack.version === 'string' && r.ack.version.length > 0, 'an ack carries a version')
    // read-your-writes: this client's own view is at or past its ack, in that partition
    const got = await r.client.get('gadgets', { version: true })
    c.ok(got.version >= r.ack.version, `read-your-writes: ${got.version} >= ${r.ack.version}`)
  }
  await c.settle()
  c.ok([{ stock: 3 }, { stock: 4 }].some((x) => JSON.stringify(x) === JSON.stringify(shop.snapshot.gadgets)), 'gadgets ends as one of the written rows')
  c.eq(Object.keys(shop.snapshot).sort(), ['gadgets', 'widgets'], 'the seed applied once, nothing else')
  c.ok(taps > 0, 'the server tap fires on commits')
}, { seeds: 50 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
