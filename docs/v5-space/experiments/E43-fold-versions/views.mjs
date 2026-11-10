// E-43: do views over the fold agree (a) between Node versions and (b) between a view that watched every
// record and the same view built fresh on the final rows? Folds the first <limit> records through the lane.
//   node views.mjs <tree> <stream dir> [limit=200000]
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { canon } from './canon.mjs'
const [TREE, STREAM, LIMIT = '200000'] = process.argv.slice(2)
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const N = Number(LIMIT)
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const isRow = (r) => r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Uint8Array)
const num = (r) => (isRow(r) && typeof r.n === 'number' ? r.n : undefined)
const frac = (r) => (isRow(r) && typeof r.n === 'number' && Number.isFinite(r.n) ? r.n / 10 : undefined) // tenths: not exact in binary
const str = (r) => (isRow(r) && typeof r.s === 'string' ? r.s : '')
const views = (p) => ({
  'length': p.length(),
  'sum(n) raw field': p.sum('n'),
  'sum of finite n': p.map(num).sum(),
  'sum of n/10': p.map(frac).sum(),
  'avg of n/10': p.map(frac).avg(),
  'max of finite n': p.map(num).max(),
  'filter n>500': p.filter((r) => isRow(r) && r.n > 500),
  'group by s': p.group(str),
  'az by s (code units)': p.az((a, b) => (str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0)),
  'az by s (localeCompare)': p.az((a, b) => str(a).localeCompare(str(b))),
  'top 10 by n': p.filter((r) => isRow(r) && typeof r.n === 'number' && Number.isFinite(r.n)).za('n', 10),
})
// two digests per view: its value with keys in the view's own order, and with keys sorted (content only)
const read = (v) => { try { const x = v[D.value]; return sha(canon(x)) + '/' + sha(canon(x, true)) } catch (e) { return 'ERR ' + String(e.message).slice(0, 60) } }
const p = D.$({})
let live; const made = {}
try { live = views(p) } catch (e) { console.log(JSON.stringify({ error: 'views() threw: ' + e.message })); process.exit(0) }
for (const k of Object.keys(live)) { try { live[k].sink({ apply() {} }) } catch { try { live[k].connect({}, () => {}) } catch (e) { made[k] = 'no subscriber: ' + e.message } } } // a live subscriber, so the view stays maintained
const lane = D.lane(p, { onReject: () => {} })
const fd = fs.openSync(STREAM + '/stream.log', 'r'); const lenBuf = Buffer.alloc(4)
let i = 0
while (i < N && fs.readSync(fd, lenBuf, 0, 4) === 4) {
  const buf = Buffer.alloc(lenBuf.readUInt32LE(0)); fs.readSync(fd, buf, 0, buf.length)
  const rv = new C.Frame(buf).records(); const recs = []; for (let j = 0; j < rv.length && i + j < N; j++) recs.push(rv[j].rec())
  try { lane(recs) } catch (e) { made.laneThrew = (made.laneThrew ?? 0) + 1 }
  i += recs.length
}
const fresh = views(p) // the same views, built now on the final rows
const res = {}
for (const k of Object.keys(live)) { const a = read(live[k]), b = read(fresh[k]); res[k] = { live: a, fresh: b, sameOrder: a === b, sameContent: a.split('/')[1] === b.split('/')[1] } }
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer); const bits = (x) => (typeof x === 'number' ? (f64[0] = x, x + ' (' + u32[1].toString(16) + '.' + u32[0].toString(16) + ')') : String(x))
// are the ordered views apart only in how they order rows that compare equal? Compare the sort fields alone.
const seq = (v, f) => { const x = v[D.value]; return sha(JSON.stringify((Array.isArray(x) ? x : Object.values(x)).map(f))) }
const ties = {
  'az by s (code units)': seq(live['az by s (code units)'], str) === seq(fresh['az by s (code units)'], str),
  'az by s (localeCompare)': seq(live['az by s (localeCompare)'], str) === seq(fresh['az by s (localeCompare)'], str),
  'top 10 by n': seq(live['top 10 by n'], (r) => r?.n) === seq(fresh['top 10 by n'], (r) => r?.n),
}
console.log(JSON.stringify({ sameSortFieldSequence: ties, data: fs.readFileSync(TREE + '/COMMIT', 'utf8').trim(), node: process.version, records: i, rows: p[D.node].snapshot().size, notes: made, views: res,
  values: { 'sum(n) raw field': [bits(live['sum(n) raw field'][D.value]), bits(fresh['sum(n) raw field'][D.value])], 'sum of n/10': [bits(live['sum of n/10'][D.value]), bits(fresh['sum of n/10'][D.value])], 'avg of n/10': [bits(live['avg of n/10'][D.value]), bits(fresh['avg of n/10'][D.value])] } }))
