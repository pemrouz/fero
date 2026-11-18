// does `await lens` (here if held, else a trip) depend on when the collector runs?
const P = new URL('../proto/lens.mjs', import.meta.url).href
const { fero, Loop } = await import(P)
async function run(collect) {
  const srv = fero('s', { depth: 2, data: { p: { a: { n: 1 } }, q: { b: { n: 2 } } } })
  const tr = new Loop(srv); const cl = fero('s', { depth: 2, role: 'client', transport: tr, linger: 0 })
  ;(() => { const t = {}; cl.data.p.connect(t, (tt, c) => { tt.n = c.now }) })() // the program drops t at once
  srv.set(['p', 'a'], { n: 2 })
  await new Promise((r) => setTimeout(r, 5))
  if (collect) { globalThis.gc(); await new Promise((r) => setTimeout(r, 5)); globalThis.gc() }
  srv.set(['p', 'a'], { n: 3 }) // the delivery check ends the link if its target was collected
  await new Promise((r) => setTimeout(r, 5))
  const g0 = tr.stats.gets
  const v = await (process.env.FIRST_BUILD ? cl.data.p.a : cl.data.p.a.get()) // the first build read by `await lens`
  return { collect, value: v, gets: tr.stats.gets - g0, subs: tr.stats.subs, unsubs: tr.stats.unsubs }
}
console.log(JSON.stringify(await run(false)))
console.log(JSON.stringify(await run(true)))
