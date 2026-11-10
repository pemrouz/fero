// E-43 side probe: one record that sets an array's length. `update [row, 'tags', 'length'] = n` is folded as a
// plain property write, so the array becomes n long (with holes). How long does the next write under that array
// take, and what does the row cost to encode?
//   node bigarray.mjs <tree>
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
const TREE = process.argv[2]
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
const ms = (fn) => { const t = process.hrtime.bigint(); let r; try { r = fn() } catch (e) { r = 'THROWS ' + String(e.message).slice(0, 80) } return [+(Number(process.hrtime.bigint() - t) / 1e6).toFixed(3), r] }
for (const n of [1000, 100000, 10000000, 100000000]) {
  const p = D.$({}); const lane = D.lane(p, { onReject: () => {} })
  lane([{ type: 1, key: [], at: 'a', value: { tags: [1, 2, 3], n: 1 } }])
  const [setMs] = ms(() => lane([{ type: 0, key: ['a', 'tags', 'length'], value: n }]))
  const row = p[D.node].get('a')
  const [besideMs] = ms(() => lane([{ type: 0, key: ['a', 'n'], value: 2 }]))
  const [underMs] = ms(() => lane([{ type: 0, key: ['a', 'tags', '1'], value: 9 }]))
  const [encMs, enc] = n <= 10000000 ? ms(() => C.encodeFrame([{ type: 0, key: ['a'], value: p[D.node].get('a') }]).length) : [null, 'not tried']
  console.log(JSON.stringify({ data: fs.readFileSync(TREE + '/COMMIT', 'utf8').trim(), node: process.version, lengthSetTo: n, arrayLengthAfter: row.tags.length, recordBytes: C.encodeFrame([{ type: 0, key: ['a', 'tags', 'length'], value: n }]).length, msToSetIt: setMs, msForAWriteBesideTheArray: besideMs, msForOneWriteUnderTheArray: underMs, msToEncodeTheRow: encMs, encodedRowBytes: enc }))
}
