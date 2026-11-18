// skeptic probes on E-55's prototype (read-only import)
const P = new URL('../proto/lens.mjs', import.meta.url).href
const { fero, Loop, VALUE } = await import(P)
const out = (k, v) => console.log(k.padEnd(52), v)
const show = (x) => (typeof x === 'function' ? 'the lens itself' : JSON.stringify(x))

// 1. a lens returned from an async function is awaited: a hidden read
{
  const srv = fero('s', { data: { k: { n: 1 } } })
  const tr = new Loop(srv); const cl = fero('s', { role: 'client', transport: tr })
  async function lensFor(k) { return cl.data[k] }
  const x = await lensFor('k')
  out('async fn returning a lens gives', show(x) + ' (GETs: ' + tr.stats.gets + ')')
  const y = await Promise.all([cl.data.k])
  out('Promise.all([lens]) gives', '[' + y.map(show) + '] (GETs: ' + tr.stats.gets + ')')
}
// 2. duck typing: what library probes see
{
  const srv = fero('s', { data: { k: { n: 1 } } })
  const L = srv.data.k
  out('typeof lens', typeof L)
  out('typeof lens.subscribe (svelte store probe)', typeof L.subscribe)
  out('typeof lens.$$typeof (react)', typeof L.$$typeof)
  out('typeof lens.asymmetricMatch (jest)', typeof L.asymmetricMatch)
  let j; try { j = JSON.stringify({ a: L }) } catch (e) { j = 'throws ' + e.message }
  out('JSON.stringify({ a: lens })', j)
  let s; try { s = `${L}` } catch (e) { s = 'throws ' + e.message }
  out('template string', s)
  let c; try { c = structuredClone(L) } catch (e) { c = 'throws ' + e.name }
  out('structuredClone(lens)', c)
}
// 3. a view right of here(): close it, write, is the user's function still called?
{
  const srv = fero('s', { depth: 2, data: { p: { a: { n: 1 }, b: { n: 2 } } } })
  const h = srv.data.p.here()
  const v = h.gt('n', 0)
  let calls = 0
  v.tap(() => calls++)
  const before = calls
  v.close()
  srv.set(['p', 'a'], { n: 5 }); srv.set(['p', 'c'], { n: 7 })
  out('view tap calls after close (should be 0)', calls - before)
  out('views kept in r.views after close', srv.views.size)
}
// 4. connect through operators left of here(): is the target held weakly?
{
  const srv = fero('s', { depth: 2, data: { p: { a: { n: 1 } } } })
  let t = { n: 0 }
  const wr = new WeakRef(t)
  srv.data.p.gt('n', 0).connect(t, (tt, c) => { tt.n++ })
  t = null
  await new Promise((r) => setTimeout(r, 10)); globalThis.gc?.(); await new Promise((r) => setTimeout(r, 10)); globalThis.gc?.()
  out('target of selection.connect collected after gc', wr.deref() === undefined)
}
// 5. a method on a deeper path than its author expects
{
  const srv = fero('s', { data: { widgets: { left: 5 } }, methods: { sell: (n, ctx) => ctx.at.left.set({ $incr: -n }) } })
  srv.methods.sell
  await srv.data.widgets.left.call('sell', 1).catch(() => {})
  out('row widgets after widgets.left.sell(1)', JSON.stringify(srv.eng.readSync(['widgets'])))
  await srv.data.call?.('sell', 1)
}
