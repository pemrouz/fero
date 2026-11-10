// E-43 side probe: row keys and field names that are also names on Object.prototype. Does a record with one of
// them change a built-in (prototype pollution), and does the public snapshot still show the row?
//   node hostile.mjs <tree>
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
const [TREE] = process.argv.slice(2)
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const res = {}
const run = (name, recs) => {
  const p = D.$({}); const rej = []
  let threw = null
  try { D.lane(p, { onReject: (r) => rej.push(String(r.error.message).slice(0, 70)) })(recs) } catch (e) { threw = String(e.message).slice(0, 70) }
  const engine = [...p[D.node].snapshot().keys()]
  let pub; try { pub = Object.keys(p[D.value]) } catch (e) { pub = 'THROWS ' + e.message }
  const polluted = Object.keys(Object.prototype).concat(({}).polluted !== undefined ? ['polluted=' + ({}).polluted] : [])
  for (const k of Object.keys(Object.prototype)) delete Object.prototype[k]
  const a = p[D.node].snapshot().get('a')
  const rowA = a === undefined ? null : { ownKeys: Object.keys(a), readsPolluted: a.polluted ?? null, plainPrototype: Object.getPrototypeOf(a) === Object.prototype }
  res[name] = { engineRows: engine, publicRows: pub, rowA, rejects: rej, threw, objectPrototypeAfter: polluted }
}
run('row key __proto__', [{ type: 1, key: [], at: '__proto__', value: { polluted: 'yes' } }, { type: 1, key: [], at: 'a', value: { x: 1 } }])
run('field path __proto__', [{ type: 1, key: [], at: 'a', value: { x: 1 } }, { type: 0, key: ['a', '__proto__', 'polluted'], value: 'yes' }])
run('field path constructor.prototype', [{ type: 1, key: [], at: 'a', value: { x: 1 } }, { type: 0, key: ['a', 'constructor', 'prototype', 'polluted'], value: 'yes' }])
run('row keys constructor, toString', [{ type: 1, key: [], at: 'constructor', value: { x: 1 } }, { type: 1, key: [], at: 'toString', value: { x: 2 } }, { type: 0, key: ['constructor', 'y'], value: 3 }])
console.log(JSON.stringify({ data: fs.readFileSync(TREE + '/COMMIT', 'utf8').trim(), node: process.version, ...res }))
