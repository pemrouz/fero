// Claim 4: the call space holds. A row whose fields are named like fero's verbs and like a method; each field is
// reached by a step (or at), each verb by a call; a method named like a verb by call(name, arg); printing a lens
// prints its path.
//   node --experimental-strip-types callspace.mjs
import util from 'node:util'
import { fero, VALUE, Loop } from '../proto/lens.mjs'
import { out } from './common.mjs'

const f = fero('shop', {
  data: { r1: { set: 1, filter: 2, connect: 3, here: 4, then: 5, sell: 6, top: 7 }, widgets: { left: 10 } },
  // review F8: a method on a path declares where it may be called; a bare function is for the root only
  methods: { sell: { at: 'row', run: (n, ctx) => ctx.at.left.set((v) => v - n) }, top: { at: 'any', run: (n) => 'method top ' + n }, low: (max) => 'low ' + max },
})
const cases = []
const check = (name, fn, want) => { let got; try { got = fn() } catch (e) { got = 'threw ' + (e.code ?? e.message) } cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got: String(got).slice(0, 60) }) }
const checkAsync = async (name, fn, want) => { let got; try { got = await fn() } catch (e) { got = 'threw ' + (e.code ?? e.message) } cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got: String(got).slice(0, 60) }) }
// fields named like verbs, reached by a step
for (const [k, v] of [['set', 1], ['filter', 2], ['connect', 3], ['here', 4], ['sell', 6], ['top', 7]]) check(`step .${k} is the field`, () => f.data.r1[k][VALUE], v)
// `then` is reserved (it reads as undefined, so a lens is not a promise): the field takes at()
check('at(r1, then) is the field', () => f.at('r1', 'then')[VALUE], 5)
check('lens.at(then) is the field', () => f.data.r1.at('then')[VALUE], 5)
check('lens.then is undefined: a lens is not a promise', () => typeof f.data.r1.then, 'undefined')
await checkAsync('lens.get() reads once', async () => await f.data.widgets.left.get(), 10)
await checkAsync('f.at(...).get() reads once', async () => await f.at('widgets', 'left').get(), 10)
// review F3: nothing that resolves a value may read through a lens by accident
{
  const srv = fero('s', { data: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['k' + i, { n: i }])) })
  const tr = new Loop(srv), cl = fero('s', { role: 'client', transport: tr })
  const isLens = (x) => typeof x === 'function' && String(x).startsWith('s')
  await checkAsync('await lens gives the lens back, no trip', async () => { const x = await cl.data.k1; return [isLens(x), tr.stats.gets] }, [true, 0])
  await checkAsync('an async function may return a lens: no trip', async () => { const g = async () => cl.data.k1; return [isLens(await g()), tr.stats.gets] }, [true, 0])
  await checkAsync('an async function may return the ROOT lens: no download', async () => { const g = async () => cl.data; return [isLens(await g()), tr.stats.gets] }, [true, 0])
  await checkAsync('Promise.all([lens]): no trip', async () => { const [x] = await Promise.all([cl.data.k1]); return [isLens(x), tr.stats.gets] }, [true, 0])
  await checkAsync('Promise.resolve(lens): no trip', async () => { const x = await Promise.resolve(cl.data.k1); return [isLens(x), tr.stats.gets] }, [true, 0])
  await checkAsync('lens.get() on a client is one trip', async () => { const v = await cl.data.k1.get(); return [v, tr.stats.gets] }, [{ n: 1 }, 1])
}
// the names libraries probe read as undefined; a field so named takes at()
for (const k of ['toJSON', 'constructor', '$$typeof', 'asymmetricMatch', 'nodeType', 'subscribe']) check(`lens.${k} is undefined (a probe name)`, () => typeof f.data.r1[k], 'undefined')
check('JSON.stringify({ a: lens }) does not throw (a lens has no JSON form)', () => JSON.stringify({ a: f.data.r1 }), '{}')
check('structuredClone(lens) throws DataCloneError: a lens cannot be sent', () => { try { structuredClone(f.data.r1); return 'cloned' } catch (e) { return e.name } }, 'DataCloneError')
check('a field named subscribe by at()', () => { f.set(['r1', 'subscribe'], 8); return f.at('r1', 'subscribe')[VALUE] }, 8)
// review F23: at() with a number key is the same address as a property step
{
  const g = fero('g', { data: { 1: { n: 7 } } })
  check('data[1].n', () => g.data[1].n[VALUE], 7)
  check('at(1, n) reaches the same row as data[1].n', () => g.at(1, 'n')[VALUE], 7)
  check('lens.at(1).n too', () => g.data.at(1).n[VALUE], 7)
  check('at({}) is refused', () => g.at({}, 'n'), 'threw bad-key')
}
// verbs by call
f.data.r1.set.set(11); check('.set.set(11) writes the field named set', () => f.rows.r1.set, 11)
f.data.r1.filter.set(12); check('.filter.set(12) writes the field named filter', () => f.rows.r1.filter, 12)
check('.here() on a row is the verb', () => typeof f.data.r1.here().close, 'function')
check('.connect(t, prop) on a field is the verb', () => { const t = { v: 0 }; f.data.r1.connect.connect(t, 'v'); return t.v }, 3)
check('.filter(fn) left of here() is refused', () => f.data.r1.filter((x) => x), 'threw unencodable')
// a method on a path; a method named like an operator; the way out
await checkAsync('.sell(1) on a path runs the method with ctx.at', async () => { await f.data.widgets.sell(1); return f.rows.widgets.left }, 9)
check('.top(3): fero\'s operator wins over the method', () => f.data.widgets.top(3).constructor.name, 'Selection')
await checkAsync('.call(top, 3): the method', () => f.data.widgets.call('top', 3), 'method top 3')
// review F8: the server checks the path a client chose
await checkAsync('.sell(1) below a row is refused bad-path', () => f.data.widgets.left.sell(1), 'threw bad-path')
check('the refused call changed nothing: left is still a number', () => f.rows.widgets.left, 9)
await checkAsync('.call(sell) at the root is refused bad-path', () => f.data.call('sell', 1), 'threw bad-path')
await checkAsync('a bare function is for the root: on a path it is refused', () => f.data.widgets.low(5), 'threw bad-path')
await checkAsync('a bare function at the root runs', () => f.data.call('low', 5), 'low 5')
// printing
check('util.inspect(lens) prints the path', () => util.inspect(f.data.r1.set), 'Lens(shop.r1.set)')
check('String(lens) prints the path', () => String(f.data.widgets.left), 'shop.widgets.left')
check('typeof lens', () => typeof f.data.r1, 'function')
check('f.at(...) prints its path', () => util.inspect(f.at('r1', 'then')), 'At(shop.r1.then)')
out({ claim: 4, bench: 'callspace', cases: cases.length, passed: cases.filter((c) => c.ok).length, failing: cases.filter((c) => !c.ok) })
