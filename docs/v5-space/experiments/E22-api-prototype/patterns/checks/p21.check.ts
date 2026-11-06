// P-21's check (REQUIREMENTS P-21): with no answerer, an ask is refused 'no-answerer' at once. Two
// answerers serve two askers (5 asks each); in odd seeds one answerer is killed mid-request. Every
// ask gets its own answer or 'timeout', never two (at most one reply row per request, from the log);
// leader changes and a move land in the work. The hops of an ask in a calm run are recorded (Q-A17).
import { check, report, isMain, servers, committed, code, fero, sleep } from './common.ts'
import { worker, app } from '../p21-request-reply.ts'
import { service } from '../lib/index.ts'

export const lat: number[] = []
export const one: number[] = []
export const tally: Record<string, number> = {}
export const run = () => check('p21-request-reply', async (c) => {
  await servers(c, 3, () => service('thumbs'))
  const [x, y] = c.procs('x', 'y')
  const t0 = c.w.time
  c.eq(await code(() => x.run(() => app('a.png', () => {}))), 'no-answerer', 'no live answerer: refused')
  c.ok(c.w.time - t0 < 0.01, 'at once')
  const resize = async (url: string) => { await sleep(20); return `small-${url}` }
  const ans = c.procs('a1', 'a2')
  const runners = await Promise.all(ans.map((p) => p.run(() => worker(resize))))
  await c.settle()
  // one calm ask: its virtual time minus the answerer's 20 ms of work
  const t1 = c.w.time
  await x.run(() => app('calm.png', () => {}))
  lat.push(c.w.time - t1 - 20)
  const t2 = c.w.time
  await x.run(async () => (await fero('svc.thumbs')).set('probe/x', { n: 1 }))
  one.push(c.w.time - t2)
  c.chaos({ leaderChanges: 1, moves: 1, within: 200 })
  if (c.seed % 2) c.w.faults([{ at: c.w.time + 5 + (c.seed % 30), do: 'kill', proc: 'a1' }])
  const ask = (p: any, i: number) => p.run(() => app(`${p.id}${i}.png`, () => {})).then((o: any) => (o.url === `small-${p.id}${i}.png` ? 'answer' : `wrong ${o.url}`), (e: any) => e.code)
  const outs = await Promise.all([x, y].map(async (p) => { const r: string[] = []; for (let i = 0; i < 5; i++) r.push(await ask(p, i)); return r }))
  for (const o of outs.flat()) tally[o] = (tally[o] ?? 0) + 1
  c.ok(outs.flat().every((o) => o === 'answer' || o === 'timeout'), `each ask: its answer or timeout (${outs.flat()})`)
  const replies = committed(c, 'svc.thumbs').filter((e: any) => e.k === 'w' && e.p.startsWith('r~') && e.recs[0]?.type !== 2)
  const per: Record<string, number> = {}
  for (const e of replies) { const k = String(e.recs[0].key[0]); per[k] = (per[k] ?? 0) + 1 }
  c.ok(Object.values(per).every((n) => n === 1), 'at most one reply per request')
  for (const r of runners) if (r) await Promise.race([r.stop(), sleep(3000)])
}, { seeds: 40 })

if (isMain(import.meta.url)) {
  report(await run(), import.meta.url)
  const s = [...lat].sort((a, b) => a - b)
  const o = [...one].sort((a, b) => a - b)
  console.log(`  a calm ask, minus the answerer's work: median ${s[s.length >> 1]?.toFixed(2)} ms, max ${s[s.length - 1]?.toFixed(2)} ms of virtual time; one plain write from the asker: median ${o[o.length >> 1]?.toFixed(2)} ms; outcomes ${JSON.stringify(tally)}`)
}
