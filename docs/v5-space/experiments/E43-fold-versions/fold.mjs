// E-43: fold the stream with one data commit, on the Node that runs this file, and write what came out.
//   node fold.mjs <tree> <stream dir> <mode> <out prefix> [limit] [explain=i,j,...]
// <tree> holds fero/kernel/codec.ts (to read the stream), fero/api/substrate.ts (mode seam) and data/ (the commit).
// Modes:  lane-rec    data's hot lane, one record per call (what fero v4's applyRec does, without its repairs)
//         lane-b256   data's hot lane, one frame of 256 per call (what a v5 kernel handing over a batch would do)
//         ingest-rec  the handle's ingest() with v2-profile records, one per call (how a client mirror folds)
//         ingest-b256 the same, one frame per call
//         seam        fero v4's own substrate.applyRec (the lane plus fero's two repairs)
// Output: <out>.json (counts and SHA-256 digests of the snapshot at 20 checkpoints and at the end) and, for the
// per-record modes, <out>.dig: one u32 per record = the record's outcome and the touched row after it.
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { canon, fnv } from './canon.mjs'

const [TREE, STREAM, MODE, OUT, LIMIT = '0', EXPLAIN = ''] = process.argv.slice(2) // EXPLAIN: a file of record numbers, one per line
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)
const D = await import(pathToFileURL(TREE + '/data/api/index.ts').href)
const contract = await import(pathToFileURL(TREE + '/data/contract/index.ts').href)
const S = MODE === 'seam' ? await import(pathToFileURL(TREE + '/fero/api/substrate.ts').href) : null
const meta = JSON.parse(fs.readFileSync(STREAM + '/stream.json', 'utf8'))
const N = Number(LIMIT) > 0 ? Math.min(Number(LIMIT), meta.records) : meta.records
const explain = new Set(EXPLAIN ? fs.readFileSync(EXPLAIN, 'utf8').split('\n').filter(Boolean).map(Number) : [])
const explained = []
// what the record meets: the sorts of value along its path in the row as it stands, and what sits at the leaf
const sort = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Uint8Array ? 'bytes' : typeof v)
const situation = (has, rowv, r) => {
  const verb = ['update', 'insert', 'remove'][r.type] ?? 'type-' + r.type
  if (r.key.length <= 1) return verb + ' row; row ' + (has ? sort(rowv) : 'absent')
  if (!has) return verb + ' deep; row absent'
  let cur = rowv; const chain = [sort(cur)]
  for (let d = 1; d < r.key.length - 1; d++) {
    if (cur === null || typeof cur !== 'object' || cur instanceof Uint8Array || !Object.prototype.hasOwnProperty.call(cur, r.key[d])) { chain.push('absent'); cur = undefined; break }
    cur = cur[r.key[d]]; chain.push(sort(cur))
  }
  const seg = r.key[r.key.length - 1]
  let leaf = 'none'
  if (cur !== null && typeof cur === 'object' && !(cur instanceof Uint8Array)) {
    const own = Object.prototype.hasOwnProperty.call(cur, seg)
    const idx = Array.isArray(cur) ? (/^(0|[1-9]\d*)$/.test(seg) ? (Number(seg) < cur.length ? 'index in range' : 'index out of range') : 'a name, not an index') : ''
    leaf = (own ? 'own ' + sort(cur[seg]) : 'absent') + (idx ? ', ' + idx : '')
  }
  return verb + ' deep; under ' + chain.join(' > ') + '; leaf ' + leaf + ('value' in r && r.type === 0 ? '; writes ' + sort(r.value) : '')
}

const p = S ? S.proxy({}) : D.$({})
const node = p[D.node]
const rows = () => node.snapshot() // the engine's own row map, in the engine's own order (a fresh map: used at checkpoints only)
const has = (k) => node.hasRow(k), get = (k) => node.get(k) // one row, without copying the map
const rowKeyOf = (r) => (r.key.length > 0 ? r.key[0] : r.at)
const V2 = ['update', 'insert', 'remove', 'bogus']
const toV2 = (r) => {
  const o = { type: V2[r.type] ?? 'bogus', key: r.key }
  if (r.type === 1 && r.key.length === 1) { o.key = []; o.at = r.key[0] } else if (r.at !== undefined) o.at = r.at
  if ('value' in r) o.value = r.value
  return o
}

const rejects = []
const onReject = (rj) => rejects.push(rj)
const lane = MODE.startsWith('lane') ? D.lane(p, { onReject }) : null
const per = MODE.endsWith('-rec') || MODE === 'seam'
const dig = per ? new Uint32Array(N) : null // the touched row after each record
const outc = per ? new Uint8Array(N) : null // 0 the record was taken, 1 it was refused (a reject or a throw), 2 left out
let rejected = 0, threw = 0, calls = 0, skipped = 0
const kindsBuf = fs.readFileSync(STREAM + '/stream.kinds')
const ingestMode = MODE.startsWith('ingest')
// the malformed lane records mean other things in the v2 profile (an update with key [] replaces the whole source,
// an insert with no key appends): the ingest modes leave them out, by shape
const notV2 = (r) => r.type > 2 || (r.type === 0 && r.key.length === 0) || (r.type === 1 && (r.key.length > 1 || (r.key.length === 0 && r.at === undefined))) || (r.type === 2 && r.key.length === 0)
const msgClass = new Map()
const classify = (e) => String(e?.message ?? e).replace(/\[[^\]]*\]/g, '[..]').replace(/key .*? is/g, 'key .. is').replace(/"[^"]*"/g, '".."').replace(/\d+/g, '#').slice(0, 110)
const note = (e) => { const c = classify(e); msgClass.set(c, (msgClass.get(c) ?? 0) + 1); return c }

// one call into the fold; returns the outcome text ('' = applied) for a per-record call
const feed = (recs) => {
  rejects.length = 0
  let out = ''
  calls++
  try {
    if (MODE === 'seam') S.applyRec(p, recs[0])
    else if (lane) lane(recs)
    else p.ingest(recs.map(toV2), { onReject })
  } catch (e) {
    threw++; out = 'threw: ' + note(e)
  }
  for (const rj of rejects) { rejected++; const c = note(rj.error); if (out === '') out = 'reject: ' + c }
  return out
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const snap = () => {
  const m = rows()
  let eng = ''; for (const [k, v] of m) eng += JSON.stringify(String(k)) + ':' + canon(v) + '\n'
  const pub = p[D.value] // the public dense snapshot
  const srt = [...m.entries()].map(([k, v]) => JSON.stringify(String(k)) + ':' + canon(v, true)).sort().join('\n')
  return { rows: m.size, publicRows: Object.keys(pub).length, public: sha(canon(pub)), engine: sha(eng), sorted: sha(srt) }
}

const fd = fs.openSync(STREAM + '/stream.log', 'r')
const lenBuf = Buffer.alloc(4)
const checkpoints = []
const EVERY = 50000
let i = 0, t0 = process.hrtime.bigint()
while (i < N) {
  if (fs.readSync(fd, lenBuf, 0, 4) !== 4) break
  const buf = Buffer.alloc(lenBuf.readUInt32LE(0)); fs.readSync(fd, buf, 0, buf.length)
  const rv = new C.Frame(buf).records(); let recs = new Array(rv.length); for (let j = 0; j < rv.length; j++) recs[j] = rv[j].rec()
  if (i + recs.length > N) recs = recs.slice(0, N - i)
  if (per) {
    for (let j = 0; j < recs.length; j++) {
      const r = recs[j], k = rowKeyOf(r), idx = i + j
      if (ingestMode && notV2(r)) { skipped++; dig[idx] = 0; outc[idx] = 2; continue }
      const ex = explain.has(idx)
      const sit = ex ? situation(k !== undefined && has(k), get(k), r) : null
      const before = ex ? (k !== undefined && has(k) ? canon(get(k)) : '(no row)') : null
      const out = feed([r])
      const after = k !== undefined && has(k) ? canon(get(k)) : '(no row)'
      dig[idx] = fnv(after); outc[idx] = out === '' ? 0 : 1
      if (ex) explained.push({ index: idx, kind: meta.kinds[kindsBuf[idx]], situation: sit, record: canon(r), before, outcome: out || 'applied', after })
    }
  } else if (ingestMode) { const keep = recs.filter((r) => !notV2(r)); skipped += recs.length - keep.length; feed(keep) }
  else feed(recs)
  const prev = i; i += recs.length
  if (Math.floor(prev / EVERY) !== Math.floor(i / EVERY) || i >= N) checkpoints.push({ at: i, ...snap() })
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6
const final = checkpoints[checkpoints.length - 1]
const result = {
  data: fs.readFileSync(TREE + '/COMMIT', 'utf8').trim(), schedule: contract.SCHEDULE_VERSION, node: process.version, v8: process.versions.v8,
  mode: MODE, records: i, calls, skipped, rejected, threw, ms: Math.round(ms), final,
  checkpoints: checkpoints.map((c) => c.at + ':' + c.engine).join(' '),
  chain: sha(checkpoints.map((c) => c.public + c.engine + c.sorted).join('')),
  digest: dig ? sha(Buffer.from(dig.buffer)) : null, outcomes: outc ? sha(outc) : null, refused: outc ? outc.reduce((a, x) => a + (x === 1 ? 1 : 0), 0) : null,
  messages: Object.fromEntries([...msgClass.entries()].sort((a, b) => b[1] - a[1])),
  stream: meta.sha256.slice(0, 16),
}
fs.writeFileSync(OUT + '.json', JSON.stringify(result))
if (explained.length) fs.writeFileSync(OUT + '.explain.jsonl', explained.map((e) => JSON.stringify(e)).join('\n') + '\n')
if (dig && !EXPLAIN) { fs.writeFileSync(OUT + '.dig', Buffer.from(dig.buffer)); fs.writeFileSync(OUT + '.out', outc) }
const { messages, checkpoints: _c, explained: _e, ...short } = result
console.log(JSON.stringify(short))
