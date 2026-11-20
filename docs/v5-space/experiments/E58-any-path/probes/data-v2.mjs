// E-58 probe (kept after the review): data v2, the proxy library published as data@2.0.0, which fero v2 and v3 used.
// Writes at any depth through assignment; per-path subscribers (`connect([])` collects the records a path gets).
// It shows what ANYPATH.md section 1 says of data v2: writes at any depth and at the root, records relative to each
// subscriber, a throw under a `null` parent and on a remove under a missing row, and unchanged values sent again
// to subscribers below a write above them.
//   node data-v2.mjs <folder of the unpacked data-2.0.0 package>/dist/index.js      (run.sh probes fetches it)
const { $, value } = await import(process.argv[2])

const ser = (o) => JSON.stringify(o, (_k, v) => (v === undefined ? '<undef>' : v))
const say = (name, o) => console.log(name + ' ' + ser(o))
const tryIt = (name, fn) => { try { fn() } catch (e) { say(name + ' THROWS', String(e && e.message).slice(0, 160)) } }

// 1. one resource, subscribers at the root, a row, a field, two nested fields, a sibling row, a missing row, a
//    missing path; then writes at every level. Each line prints the records each subscriber got for that write.
{
  const src = $({ g: { a: { b: 1, c: 2 }, n: 5 }, h: { x: 1 } })
  const subs = {}
  const take = (name, fn) => { try { subs[name] = fn() } catch (e) { say('connect ' + name + ' THROWS', String(e && e.message).slice(0, 120)) } }
  take('root', () => src.connect([])); take('g', () => src.g.connect([])); take('ga', () => src.g.a.connect([]))
  take('gab', () => src.g.a.b.connect([])); take('gac', () => src.g.a.c.connect([])); take('h', () => src.h.connect([]))
  take('k', () => src.k.connect([])); take('gz', () => src.g.z.q.connect([]))
  const marks = new Map()
  const show = (name) => {
    const o = {}
    for (const k in subs) { const from = marks.get(subs[k]) ?? 0; if (subs[k].length > from) o[k] = subs[k].slice(from); marks.set(subs[k], subs[k].length) }
    say(name, o)
  }
  show('1.0 the records each subscriber got on connect')
  tryIt('below', () => { src.g.a.b = 10 }); show('1.1 below: g.a.b = 10')
  tryIt('beside', () => { src.g.n = 6 }); show('1.2 beside: g.n = 6')
  tryIt('above-keep', () => { src.g.a = { b: 10, c: 3 } }); show('1.3 above, b kept, c changed: g.a = {b:10,c:3}')
  tryIt('above-equal', () => { src.g.a = { b: 10, c: 3 } }); show('1.4 above, a new equal object: g.a = {b:10,c:3}')
  tryIt('row-replace', () => { src.g = { a: { b: 11 }, n: 6 } }); show('1.5 row replace: g = {a:{b:11},n:6}')
  tryIt('prim', () => { src.g.a = 5 }); show('1.6 the parent becomes a number: g.a = 5')
  tryIt('deep-under-num', () => { src.g.a.b = 1 }); show('1.7 a write under a number parent: g.a.b = 1')
  tryIt('new-path', () => { src.g.z.q = 7 }); show('1.8 a write to a path that did not exist: g.z.q = 7')
  tryIt('field-remove', () => { delete src.g.a.b }); show('1.9 a field remove: delete g.a.b')
  tryIt('row-remove', () => { delete src.g }); show('1.10 a row remove: delete g')
  tryIt('deep-into-missing-row', () => { src.m.f = 1 }); show('1.11 a deep write into a missing row: m.f = 1')
  say('1.11 state', src[value])
  tryIt('root-replace', () => { src[value] = { h: { x: 2 }, g: { a: { b: 3 } } } }); show('1.12 the whole resource replaced: [value] = {...}')
  say('1.12 state', src[value])
}
// 2. arrays at a path
{
  const src = $({ g: { list: [{ v: 1 }, { v: 2 }] } })
  const l = src.g.list.connect([]), l1 = src.g.list[1].connect([])
  tryIt('arr-index', () => { src.g.list[0] = { v: 9 } }); tryIt('arr-field', () => { src.g.list[1].v = 8 })
  tryIt('arr-push', () => { src.g.list.push({ v: 3 }) }); tryIt('arr-delete', () => { delete src.g.list[0] })
  say('2 list subscriber', l); say('2 list.1 subscriber', l1); say('2 state', src[value])
}
// 3. parents that are not objects, removes under missing parents, a root replace
const t = (name, fn) => { try { say(name, fn()) } catch (e) { say(name + ' THROWS', String(e && e.message).slice(0, 140)) } }
t('3a a null parent: g.a = null, then g.a.b = 1', () => { const s = $({ g: { a: null } }); s.g.a.b = 1; return s[value] })
t('3b a string parent: g.a = "xy", then g.a.b = 1', () => { const s = $({ g: { a: 'xy' } }); s.g.a.b = 1; return s[value] })
t('3c a root replace: subscribers on m.f and h.x', () => {
  const s = $({ m: { f: 1 }, h: { x: 1 } }); const mf = s.m.f.connect([]); const hx = s.h.x.connect([])
  s[value] = { h: { x: 1 } }; return { mf, hx, state: s[value] }
})
t('3d a root replaced by a primitive', () => { const s = $({ m: { f: 1 } }); const mf = s.m.f.connect([]); s[value] = 5; return { mf, state: s[value] } })
t('3e a remove of a missing nested path', () => { const s = $({ g: {} }); delete s.g.a.b; return s[value] })
t('3f a remove of a field under a missing row', () => { const s = $({}); delete s.m.f; return s[value] })
