// E-58 parts 1 and 2: the any-path oracle, on data's real engine.
//
// One seed: a resource (depth 1 or depth 2) on E-55's prototype store (data's SourceNode underneath), and a seeded run
// of commits: writes at every level (a row replaced, a field set, a nested field set, a removal at each level, a type
// flipped, an op, a batch inside one partition, and the levels v5 refuses but data takes: the root replaced, a partition
// replaced, a partition emptied). A stand-in leader judges each write by v5's rules (absent-row, sparse-hole,
// all-or-none batches) and keeps the log: the records as written. After each commit every lens (root, partition, row,
// field, nested field, array element, a path that is not there yet) is checked against the plain model in common.mjs:
//   state      the engine's value at the lens equals the model's
//   data rule  data's own per-path reader (data:api/index.ts connectPath) on a row or below, and data's raw sink on the
//              root or a partition: did it fire, and only on a changed value? do its records, applied to a copy of the
//              lens's value, give the model's value? does a remove carry the value before?
//   E-55 rule  a tap on the same lens (E-55 proto/lens.mjs Link.feed, which E-56's connect inherits): when did it fire?
//   the log    v5's changes() reading "records under the lens" (at or below) against "at, above or below" (never
//              beside): does a reader that folds only its lens from the second kind keep the model's value?
//   -N         where `-1` and `-5` land under each reading, against the commits that changed the lens's value
// Part 2, the wire: the log records of each commit go through JSON, are split by partition, and are applied with data's
// hot lane (data:seam/index.ts lane) on a separate client fold that holds only some partitions; the client's lenses
// (data's readers on the client) are checked the same way. A second road sends E-55's c.recs() (data's merged change per
// row, toRecs) instead, as E-55's loopback does; its client is checked for state.
//
// mode 'main': only shapes v5 defines. mode 'shape': adds shapes v5 is silent on (a field write on a number or string
// row, an index past an array's end, a named field on an array, a string where a list stood, so a lens reads a
// character) and counts what each does instead of failing.
// Planted bugs (E58_MUTATE; never set in a measured run), each must make its check fail:
//   rowmerge   a whole-row write is merged into the row it replaces, keeping fields it dropped (how fero v2 and v3
//              let a row write and a field write "merge", the bug V4-18 fixed)
//   inplace    a field write changes the row object in place, then writes it back (the path-copy law broken)
//   under      a reader below a row keeps only commits with a record at or below it (v5's literal "under the lens")
//   prev       a remove carries the value after, not the one before
//   nearbeside the log reader takes a field record beside its lens, on its row, as if it were at the lens
//   wirefield  the wire drops field records (sends whole rows and removes only)
import { fero, D, SourceNode } from '../../E55-lens-prototype/proto/lens.mjs'
import { MUT, rng, deepEq, leafAt, isObj, setAt, delAt, clone, isPrefix, where, inc } from './common.mjs'

const PARTS = ['p0', 'p1', 'p2']
const ROWS = ['r0', 'r1', 'r2', 'r3']

// ── values ───────────────────────────────────────────────────────────────────────────────────────────
const prim = (r) => { const x = r(); return x < 0.45 ? r.int(4) : x < 0.8 ? r.pick(['s0', 's1', 's2']) : x < 0.9 ? null : r() < 0.5 }
const elem = (r) => (r() < 0.6 ? prim(r) : { x: prim(r) })
const list = (r) => { const n = 1 + r.int(3); const a = []; for (let i = 0; i < n; i++) a.push(elem(r)); return a }
const aval = (r) => (r() < 0.7 ? (r() < 0.5 ? { x: prim(r) } : { x: prim(r), y: prim(r) }) : prim(r))
// a row: mostly an object; 6 % a primitive (a number in the main run; a number or a string in the shape run)
function rowval(r, shape) {
  if (r() < 0.06) return shape && r() < 0.4 ? r.pick(['abc', 'xyz']) : r.int(10)
  const o = {}
  if (r() < 0.8) o.a = aval(r)
  if (r() < 0.7) o.b = prim(r)
  if (r() < 0.5) o.list = list(r)
  if (r() < 0.12) o.q = { z: prim(r) }
  if (shape && r() < 0.1) o.list = r.pick(['abc', 'xy']) // a string where a list stood: a lens on list.1 reads a character
  return o
}
const FIELDS = [['a'], ['a', 'x'], ['a', 'y'], ['b'], ['list'], ['list', '0'], ['list', '1'], ['list', '1', 'x'], ['q', 'z'], ['q']]
function fieldval(r, f) {
  const k = f.join('.')
  if (k === 'a') return aval(r)
  if (k === 'list') return list(r)
  if (f[0] === 'list' && f.length === 2) return elem(r)
  if (k === 'q') return r() < 0.7 ? { z: prim(r) } : prim(r)
  return prim(r)
}

// ── the lenses: [class, path]; depth 2 puts a partition in front ─────────────────────────────────────────
const LENS1 = [
  ['root', []], ['row', ['r0']], ['row', ['r2']], ['absent-row', ['r3']],
  ['field', ['r0', 'a']], ['field', ['r0', 'b']], ['field', ['r0', 'list']], ['nested', ['r0', 'a', 'x']], ['nested', ['r1', 'a', 'x']],
  ['element', ['r0', 'list', '1']], ['element-field', ['r1', 'list', '1', 'x']], ['not-there', ['r0', 'q', 'z']], ['not-there', ['r3', 'a', 'x']],
]
const LENS2 = [
  ['root', []], ['partition', ['p0']], ['partition', ['p2']], ['row', ['p0', 'r0']], ['row', ['p1', 'r1']], ['absent-row', ['p0', 'r3']],
  ['field', ['p0', 'r0', 'a']], ['field', ['p0', 'r0', 'b']], ['nested', ['p0', 'r0', 'a', 'x']], ['nested', ['p1', 'r0', 'a', 'x']],
  ['element', ['p0', 'r0', 'list', '1']], ['not-there', ['p0', 'r0', 'q', 'z']], ['not-there', ['p2', 'r3', 'a']],
]
const HELD1 = new Set(['r0', 'r3']) // the client's partitions (depth 1: a row is its own partition)
const HELD2 = new Set(['p0', 'p2'])

// ── the model: a plain object of rows (depth 1) or of partitions of rows (depth 2) ──────────────────────
const rowOf = (M, depth, id) => (depth === 1 ? M[id[0]] : M[id[0]]?.[id[1]])
const hasRow = (M, depth, id) => (depth === 1 ? Object.hasOwn(M, id[0]) : Object.hasOwn(M[id[0]] ?? {}, id[1]))
function putRow(M, depth, id, row) {
  if (depth === 1) return { ...M, [id[0]]: row }
  return { ...M, [id[0]]: { ...(M[id[0]] ?? {}), [id[1]]: row } }
}
function dropRow(M, depth, id) {
  if (!hasRow(M, depth, id)) return M
  if (depth === 1) { const n = { ...M }; delete n[id[0]]; return n }
  const p = { ...M[id[0]] }; delete p[id[1]]
  const n = { ...M }; if (Object.keys(p).length === 0) delete n[id[0]]; else n[id[0]] = p
  return n
}
function modelAt(M, depth, L) {
  if (L.length === 0) return M
  if (depth === 2 && L.length === 1) return M[L[0]] ?? {}
  return leafAt(rowOf(M, depth, L.slice(0, depth)), L, depth)
}
// one log record on the model: [M2, refusal | null]
function applyRec(M, depth, rec) {
  const id = rec.key.slice(0, depth), sub = rec.key.slice(depth)
  if (rec.t === 'remove') {
    if (sub.length === 0) return [dropRow(M, depth, id), null]
    if (!hasRow(M, depth, id)) return [M, null] // a field remove on a missing row: a no-op in data; v5 is silent
    const nx = delAt(rowOf(M, depth, id), sub)
    if (nx === 'sparse-hole') return [M, 'sparse-hole']
    return [nx === rowOf(M, depth, id) ? M : putRow(M, depth, id, nx), null]
  }
  if (sub.length === 0) return [hasRow(M, depth, id) && Object.is(rowOf(M, depth, id), rec.value) ? M : putRow(M, depth, id, rec.value), null]
  if (!hasRow(M, depth, id)) return [M, 'absent-row']
  const row = rowOf(M, depth, id), nx = setAt(row, sub, rec.value)
  return [nx === row ? M : putRow(M, depth, id, nx), null]
}

// ── the engine side ──────────────────────────────────────────────────────────────────────────────────
function engineAt(st, depth, L) {
  if (depth === 1) return L.length === 0 ? Object.fromEntries(st.src.snapshot()) : leafAt(st.src.get(L[0]), L, 1)
  if (L.length === 0) { const o = {}; for (const [p, s] of st.parts) if (s.rowCount() > 0) o[p] = Object.fromEntries(s.snapshot()); return o }
  const s = st.parts.get(L[0])
  if (L.length === 1) return s ? Object.fromEntries(s.snapshot()) : {}
  return leafAt(s?.get(L[1]), L, 2)
}
const engineRow = (st, depth, id) => (depth === 1 ? st.src.get(id[0]) : st.parts.get(id[0])?.get(id[1]))
const engineHas = (st, depth, id) => (depth === 1 ? st.src.hasRow(id[0]) : st.parts.get(id[0])?.hasRow(id[1]) === true)
const sourceFor = (st, depth, part) => (depth === 1 ? st.src : st.parts.get(part))

// data's raw sink(s) on a scope (the root, or a partition at depth 2): the deltas, with their partition
function scopeReader(st, depth, L, out) {
  const hs = []
  if (depth === 1) hs.push(st.src.connect({ wantsOrder: false, origin: null, apply: (b) => { for (const d of b.rows) out({ d, p: null }) } }))
  else for (const [p, s] of st.parts) if (L.length === 0 || L[0] === p) hs.push(s.connect({ wantsOrder: false, origin: null, apply: (b) => { for (const d of b.rows) out({ d, p }) } }))
  return { dispose() { for (const h of hs) h.dispose() } }
}
// data's per-path reader (W14) on a row or below: handle.get(row).get(field)….connect(anchor, fn)
function pathReader(st, depth, L, out) {
  let h = D.handleFor(sourceFor(st, depth, L[0]))
  for (const k of L.slice(depth - 1)) h = h.get(k)
  return h.connect({}, out, { clone: true })
}
// a relative record from data's per-path reader, applied to a copy of the lens's value
function applyRel(v, rec) {
  if (rec.type === 'remove') { if (rec.key.length === 0) return undefined; const n = delAt(v, rec.key); return n === 'sparse-hole' ? v : n }
  return rec.key.length === 0 ? rec.value : setAt(v, rec.key, rec.value)
}
// a scope's value (an object of rows, or of partitions of rows) from data's deltas
function applyDelta(v, { d, p }, depth, L) {
  const o = { ...v }
  if (depth === 2 && L.length === 0) {
    const pv = { ...(o[p] ?? {}) }
    if (d.op === 'remove') delete pv[d.key]; else pv[d.key] = d.row
    if (Object.keys(pv).length === 0) delete o[p]; else o[p] = pv
    return o
  }
  if (d.op === 'remove') delete o[d.key]; else o[d.key] = d.row
  return o
}
// a log reader that folds only its lens from the records at, above or below it
function foldNear(v, L, rec) {
  const w = where(L, rec.key)
  if (w === 'beside') return v
  if (w === 'above') return rec.t === 'remove' ? undefined : leafAt(rec.value, L, rec.key.length)
  const rel = rec.key.slice(L.length)
  if (rec.t === 'remove') { if (rel.length === 0) return undefined; const n = delAt(v, rel); return n === 'sparse-hole' ? v : n }
  return setAt(v, rel, rec.value)
}
// does the lens read through a string, before or after? (a sibling write that turns the string into an object changes
// what such a lens reads without a record at, above or below it: the one edge data's reader cannot see)
function throughString(Ms, depth, L) {
  if (L.length <= depth) return false
  for (const X of Ms) {
    let cur = rowOf(X, depth, L.slice(0, depth))
    for (let i = depth; i < L.length; i++) { if (cur === null || cur === undefined) break; if (typeof cur === 'string') return true; cur = cur[L[i]] }
  }
  return false
}

// ── the generator and the leader stand-in ──────────────────────────────────────────────────────────────
// returns { kind, recs: the log records as written, refused?, ingest? }
function nextWrite(r, M, depth, shape, S) {
  const ids = depth === 1 ? ROWS.map((k) => [k]) : PARTS.flatMap((p) => ROWS.map((k) => [p, k]))
  const liveIds = ids.filter((id) => hasRow(M, depth, id))
  const anyId = () => r.pick(ids)
  const live = () => (liveIds.length > 0 ? r.pick(liveIds) : anyId())
  const x = r()
  if (x < 0.03) { // the root replaced: v5 refuses it (bad-path); data takes it through a whole-value ingest
    const V = {}
    if (depth === 1) { for (const k of ROWS) if (r() < 0.6) V[k] = rowval(r, false) }
    else for (const p of PARTS) if (r() < 0.6) { V[p] = {}; for (const k of ROWS) if (r() < 0.5) V[p][k] = rowval(r, false) }
    return { kind: 'root-replace', recs: expandRoot(M, depth, V), ingest: { root: V } }
  }
  if (depth === 2 && x < 0.06) { // a partition replaced or emptied: v5 refuses both (bad-path)
    const p = r.pick(PARTS), empty = r() < 0.35, V = {}
    if (!empty) for (const k of ROWS) if (r() < 0.6) V[k] = rowval(r, false)
    return { kind: empty ? 'partition-remove' : 'partition-replace', recs: expandPart(M, p, V), ingest: { part: p, value: V } }
  }
  if (x < 0.18) { // a row set; sometimes a new object equal to the row it replaces
    const id = r() < 0.7 ? live() : anyId()
    if (r() < 0.2 && hasRow(M, depth, id) && isObj(rowOf(M, depth, id))) return { kind: 'row-equal-copy', recs: [{ t: 'set', key: id, value: clone(rowOf(M, depth, id)) }] }
    const v = rowval(r, shape)
    return { kind: hasRow(M, depth, id) ? (isObj(v) ? 'row-replace' : 'row-to-primitive') : 'row-add', recs: [{ t: 'set', key: id, value: v }] }
  }
  if (x < 0.50) return fieldWrite(r, M, depth, shape, live(), S)
  if (x < 0.58) { // a field or nested field removed; an array element is refused sparse-hole
    const id = live(), f = r.pick([['a'], ['a', 'x'], ['a', 'y'], ['b'], ['list'], ['q'], ['q', 'z'], ['list', '1']])
    return { kind: f.length === 1 ? 'field-remove' : f[0] === 'list' ? 'element-remove' : 'nested-remove', recs: [{ t: 'remove', key: [...id, ...f] }] }
  }
  if (x < 0.64) return { kind: 'row-remove', recs: [{ t: 'remove', key: r() < 0.8 ? live() : anyId() }] }
  if (x < 0.69) { // op.incr on a field: the leader computes, then appends a plain value
    const id = live(), f = r.pick([['b'], ['a', 'x']])
    if (!hasRow(M, depth, id)) return { kind: 'op-incr', refused: 'absent-row', recs: [] }
    const row = rowOf(M, depth, id)
    if (!isObj(row)) return { kind: 'op-incr', refused: 'invalid', recs: [] }
    const cur = leafAt(row, f)
    if (cur !== undefined && typeof cur !== 'number') return { kind: 'op-incr', refused: 'invalid', recs: [] }
    return { kind: 'op-incr', recs: [{ t: 'set', key: [...id, ...f], value: (cur ?? 0) + 1 }] }
  }
  if (x < 0.73) { // op.merge on a row: the leader appends the merged row whole (v5 does not say which record)
    const id = anyId(), row = rowOf(M, depth, id)
    if (hasRow(M, depth, id) && !isObj(row)) return { kind: 'op-merge', refused: 'invalid', recs: [] }
    const patch = { b: prim(r) }; if (r() < 0.5) patch.a = aval(r)
    return { kind: 'op-merge', recs: [{ t: 'set', key: id, value: { ...(row ?? {}), ...patch } }] }
  }
  if (x < 0.85) { // a batch inside one partition: 2 to 4 writes, all or none
    const id0 = live(), n = 2 + r.int(3), recs = []
    let shapeIn = null // the first write in the batch of a shape v5 does not define (the shape run only)
    const inPart = depth === 1 ? [id0] : liveIds.filter((id) => id[0] === id0[0])
    for (let i = 0; i < n; i++) {
      const id = depth === 1 ? id0 : [id0[0], r.pick(ROWS)]
      const y = r()
      if (y < 0.3) recs.push({ t: 'set', key: id, value: rowval(r, false) })
      else if (y < 0.75) { const w = fieldWrite(r, M, depth, shape, inPart.length > 0 ? r.pick(inPart) : id, S); if (w.recs.length) recs.push(w.recs[0]); if (w.kind.startsWith('shape:')) shapeIn ??= w.kind }
      else if (y < 0.9) recs.push({ t: 'remove', key: [...id, r.pick(['a', 'b', 'list'])] })
      else recs.push({ t: 'remove', key: id })
    }
    return { kind: shapeIn ? 'batch(' + shapeIn + ')' : 'batch', recs }
  }
  if (x < 0.90) { // a field write on a missing row: v5 and data refuse it
    const free = ids.filter((id) => !hasRow(M, depth, id))
    if (free.length === 0) return fieldWrite(r, M, depth, shape, live(), S)
    return { kind: 'field-on-missing-row', recs: [{ t: 'set', key: [...r.pick(free), 'a', 'x'], value: 1 }] }
  }
  if (x < 0.95) { // a field set to a new object equal to what it holds
    const id = live(), row = rowOf(M, depth, id)
    if (isObj(row) && isObj(row.a)) return { kind: 'field-equal-copy', recs: [{ t: 'set', key: [...id, 'a'], value: clone(row.a) }] }
    return fieldWrite(r, M, depth, shape, id, S)
  }
  // a type flip: object to primitive and back
  const id = live(), row = rowOf(M, depth, id)
  if (!isObj(row)) return { kind: 'row-to-object', recs: [{ t: 'set', key: id, value: { a: { x: prim(r) } } }] }
  return { kind: isObj(row.a) ? 'field-to-primitive' : 'field-to-object', recs: [{ t: 'set', key: [...id, 'a'], value: isObj(row.a) ? prim(r) : { x: prim(r) } }] }
}

// a field write at a random field path of a row. The shapes v5 does not define are counted; in the main run they are
// turned into a defined write
function fieldWrite(r, M, depth, shape, id, S) {
  let f = r.pick(FIELDS)
  const row = rowOf(M, depth, id)
  if (hasRow(M, depth, id) && !isObj(row)) {
    if (!shape) return { kind: 'row-to-object', recs: [{ t: 'set', key: id, value: { a: aval(r) } }] }
    return { kind: typeof row === 'string' ? 'shape:field-on-string-row' : 'shape:field-on-number-row', recs: [{ t: 'set', key: [...id, ...f], value: fieldval(r, f) }] }
  }
  let kind = null
  if (f[0] === 'list' && f.length > 1 && isObj(row)) {
    const lst = row.list
    if (Array.isArray(lst)) {
      if (Number(f[1]) >= lst.length) {
        if (!shape) f = ['list']
        else { kind = 'shape:past-array-end'; f = ['list', String(lst.length + 1 + r.int(2)), ...f.slice(2)] }
      } else if (shape && r() < 0.2) { kind = 'shape:named-field-on-array'; f = ['list', 'foo'] }
    } else if (typeof lst === 'string') kind = 'shape:write-under-string-field'
  }
  // v5's absent-path (a missing parent field: data fills it in); a primitive parent (v5 silent; data makes it {})
  if (isObj(row) && f.length > 1) {
    const parent = leafAt(row, f.slice(0, -1))
    if (parent === undefined) inc(S, 'v5:absent-path-but-data-fills-in')
    else if (!isObj(parent)) inc(S, 'v5:silent-primitive-parent')
  }
  return { kind: kind ?? (f.length === 1 ? 'field-set' : f[0] === 'list' ? 'element-set' : 'nested-set'), recs: [{ t: 'set', key: [...id, ...f], value: fieldval(r, f) }] }
}

// what v5 would need for the levels it refuses: the leader turns the write into row records (one log entry here)
function expandRoot(M, depth, V) {
  if (depth === 2) return PARTS.flatMap((p) => expandPart(M, p, V[p] ?? {}))
  const recs = []
  for (const k of Object.keys(M)) if (!Object.hasOwn(V, k)) recs.push({ t: 'remove', key: [k] })
  for (const k of Object.keys(V)) recs.push({ t: 'set', key: [k], value: V[k] })
  return recs
}
function expandPart(M, p, V) {
  const recs = []
  for (const k of Object.keys(M[p] ?? {})) if (!Object.hasOwn(V, k)) recs.push({ t: 'remove', key: [p, k] })
  for (const k of Object.keys(V)) recs.push({ t: 'set', key: [p, k], value: V[k] })
  return recs
}

// a client fold: its own data runtime and source(s), holding only some partitions; fed by data's hot lane
function makeClient(M, depth, HELD, S) {
  const rt = new D.Runtime()
  const st = { rt, src: null, parts: new Map(), lanes: new Map() }
  const onReject = (x) => { inc(S, 'client:lane-reject:' + (/sparse hole/.test(String(x.error)) ? 'sparse-hole' : 'other')); if (process.env.E58_DEBUG) console.error('reject', JSON.stringify(x.record), String(x.error).slice(0, 200)) }
  if (depth === 1) {
    const rows = {}; for (const k of HELD) if (Object.hasOwn(M, k)) rows[k] = clone(M[k])
    st.src = new SourceNode(rt, rows); st.lanes.set(null, D.lane(st.src, { onReject }))
  } else for (const p of HELD) { const s = new SourceNode(rt, clone(M[p] ?? {})); st.parts.set(p, s); st.lanes.set(p, D.lane(s, { onReject })) }
  return st
}
// split a frame of [type, key, value] by partition; only the held ones cross
function route(frame, depth, HELD, S, tag) {
  const by = new Map()
  for (const [type, key, value] of frame) {
    const p = key[0]
    if (!HELD.has(p)) { inc(S, tag + ':not-sent'); continue }
    inc(S, tag + ':sent')
    const lk = depth === 1 ? null : p
    if (!by.has(lk)) by.set(lk, [])
    by.get(lk).push({ type, key: depth === 1 ? key : key.slice(1), value })
  }
  return by
}

// ── one seed ──────────────────────────────────────────────────────────────────────────────────────────
export function runSeed(seed, { depth, shape = false, commits = 120 }, S) {
  const r = rng(seed * 2 + depth)
  let M
  if (depth === 1) { M = {}; for (const k of ['r0', 'r1', 'r2']) M[k] = { a: { x: 1, y: 's0' }, b: 2, list: [1, { x: 2 }] } }
  else { M = { p0: {}, p1: {} }; for (const k of ['r0', 'r1', 'r2']) M.p0[k] = { a: { x: 1 }, b: 0, list: [0, 1] }; for (const k of ['r0', 'r1']) M.p1[k] = { a: { x: 2 }, b: 's1' } }
  const f = fero('e58', { depth, data: depth === 1 ? clone(M) : { p0: clone(M.p0), p1: clone(M.p1), p2: {} } })
  const store = f.eng
  const LENS = depth === 1 ? LENS1 : LENS2
  const HELD = depth === 1 ? HELD1 : HELD2
  const failed = new Set()
  let wkind = ''
  // a broken rule: a failure in the main run; in the shape run, a count by the write that caused it
  const bad = (k) => { if (shape) { inc(S, 'shape-effect:' + k + ':' + wkind); return } inc(S, 'FAIL:' + k); failed.add(k) }
  const norm = (L, v) => (depth === 2 && L.length === 0 ? Object.fromEntries(Object.entries(v).filter(([, rows]) => Object.keys(rows).length > 0)) : v)

  // readers on every lens, on the server
  const R = LENS.map(([cls, L]) => {
    const o = { cls, L, recs: [], calls: 0, cs: [], prevEngine: engineAt(store, depth, L), logMirror: modelAt(M, depth, L), hits: { truth: [], data: [], e55: [], near: [], under: [] } }
    if (L.length >= depth) { o.h = pathReader(store, depth, L, (rec) => o.recs.push(rec)); o.mirror = applyRel(undefined, o.recs.shift()) }
    else { o.mirror = engineAt(store, depth, L); o.h = scopeReader(store, depth, L, (x) => o.recs.push(x)) }
    o.tap = f.at(...L).tap((c) => { if (!c.first) { o.calls++; o.cs.push(c) } })
    return o
  })
  // two clients: road 1 (the log records as written) and road 2 (E-55's c.recs()); readers on lenses they hold
  const clients = [makeClient(M, depth, HELD, S), makeClient(M, depth, HELD, S)]
  const CR = clients.map((cl) => LENS.filter(([, L]) => L.length > 0 && HELD.has(L[0])).map(([cls, L]) => {
    const o = { cls, L, recs: [], diverged: false }
    if (L.length >= depth) { o.h = pathReader(cl, depth, L, (rec) => o.recs.push(rec)); o.mirror = applyRel(undefined, o.recs.shift()) }
    else { o.mirror = engineAt(cl, depth, L); o.h = scopeReader(cl, depth, L, (x) => o.recs.push(x)) }
    return o
  }))
  let road2 = []
  const rootTap = f.at().tap((c) => { if (!c.first) road2.push(...c.recs()) })

  let n = 0
  for (let step = 0; step < commits * 3 && n < commits; step++) {
    const w = nextWrite(r, M, depth, shape, S)
    wkind = w.kind
    inc(S, 'kind:' + w.kind)
    if (w.refused) { inc(S, 'refused:' + w.refused); continue }
    let M2 = M, refusal = null
    for (const rec of w.recs) { const [m, ref] = applyRec(M2, depth, rec); if (ref) { refusal = ref; break } M2 = m }
    if (refusal) { inc(S, 'refused:' + refusal + ':' + w.kind); continue }
    if (w.recs.length === 0) continue
    n++
    inc(S, 'commits'); inc(S, 'records', w.recs.length)
    for (const o of R) { o.recs.length = 0; o.calls = 0; o.cs.length = 0 }
    road2 = []
    // the engine: one data commit. A throw ends the seed as failed (only a planted bug has thrown here)
    try { store.rt.batch(() => {
      if (w.ingest?.root) {
        if (depth === 1) D.ingest(store.src, [{ type: 'update', key: [], value: w.ingest.root }])
        else for (const [p, s] of store.parts) D.ingest(s, [{ type: 'update', key: [], value: w.ingest.root[p] ?? {} }])
      } else if (w.ingest?.part) D.ingest(store.parts.get(w.ingest.part), [{ type: 'update', key: [], value: w.ingest.value }])
      else for (const rec of w.recs) {
        if (rec.t === 'remove') store.remove(rec.key)
        else if (MUT === 'inplace' && rec.key.length > depth && engineHas(store, depth, rec.key.slice(0, depth)) && isObj(engineRow(store, depth, rec.key.slice(0, depth)))) {
          const id = rec.key.slice(0, depth), sub = rec.key.slice(depth), row = engineRow(store, depth, id)
          let cur = row
          for (let i = 0; i < sub.length - 1; i++) { if (!isObj(cur[sub[i]])) cur[sub[i]] = {}; cur = cur[sub[i]] }
          cur[sub[sub.length - 1]] = rec.value
          store.write(id, row) // the same object: data drops it as no change
        } else if (MUT === 'rowmerge' && rec.key.length === depth && isObj(rec.value) && !Array.isArray(rec.value) && isObj(engineRow(store, depth, rec.key))) {
          store.write(rec.key, { ...engineRow(store, depth, rec.key), ...rec.value })
        } else store.write(rec.key, rec.value)
      }
    }) } catch (err) { bad('engine-threw'); inc(S, 'engine-threw:' + String(err.message).slice(0, 40)); break }
    // part 2: road 1, the log records as written, through JSON, split by partition, on the client's lanes
    const wire = MUT === 'wirefield' ? w.recs.filter((x) => x.key.length <= depth) : w.recs
    const by1 = route(JSON.parse(JSON.stringify(wire.map((x) => [x.t === 'remove' ? D.HOT.remove : D.HOT.update, x.key, x.value]))), depth, HELD, S, 'wire')
    for (const o of CR[0]) o.recs.length = 0
    for (const [lk, recs] of by1) clients[0].lanes.get(lk)(recs)
    // road 2: E-55's c.recs() through JSON, split the same way
    const by2 = route(JSON.parse(JSON.stringify(road2)), depth, HELD, S, 'road2')
    for (const o of CR[1]) o.recs.length = 0
    for (const [lk, recs] of by2) clients[1].lanes.get(lk)(recs)

    // ── part 1: the server's lenses ──
    for (const o of R) {
      const { L, cls } = o
      const mo = modelAt(M, depth, L), mn = modelAt(M2, depth, L)
      const changed = !deepEq(norm(L, mo), norm(L, mn))
      const es = engineAt(store, depth, L)
      const through = throughString([M, M2], depth, L)
      if (!deepEq(es, norm(L, mn))) bad('state:' + cls)
      if (changed) { o.hits.truth.push(n); inc(S, 'changed:' + cls) }
      const pos = w.recs.map((x) => where(L, x.key))
      const anyUnder = pos.some((p) => p === 'at' || p === 'below'), anyNear = anyUnder || pos.includes('above')
      // data's reader
      let recs = o.recs
      if (MUT === 'under' && L.length >= depth && !anyUnder) recs = []
      const fired = recs.length > 0
      if (fired) o.hits.data.push(n)
      if (L.length >= depth) {
        for (const rec of recs) {
          if (rec.type === 'remove' && rec.key.length === 0 && !deepEq(MUT === 'prev' ? undefined : rec.value, mo)) bad('prev:' + cls)
          o.mirror = applyRel(o.mirror, rec)
        }
        if (!deepEq(o.mirror, mn)) { if (through) inc(S, 'data:compose-through-string:' + cls); else bad('compose:' + cls); o.mirror = clone(es) }
      } else {
        for (const x of recs) {
          if (x.d.op !== 'add') { const pv = (depth === 2 && L.length === 0 ? mo[x.p] : mo)?.[x.d.key]; if (!deepEq(MUT === 'prev' ? x.d.row : x.d.prev, pv)) bad('prev:' + cls) }
          o.mirror = applyDelta(o.mirror, x, depth, L)
        }
        if (!deepEq(norm(L, o.mirror), norm(L, mn))) { bad('compose:' + cls); o.mirror = es }
      }
      if (changed && !fired) { if (through) inc(S, 'data:missed-through-string:' + cls); else bad('missed:' + cls) }
      if (!changed && fired) {
        let why = 'other'
        if (L.length >= depth) { if (mo === undefined && mn === undefined) why = 'phantom-undefined-on-row-add'; else if (isObj(es) && !Object.is(o.prevEngine, es)) why = 'new-equal-object' }
        else if (recs.every((x) => x.d.op === 'update' && deepEq(x.d.row, x.d.prev))) why = 'new-equal-object'
        inc(S, 'data:fired-unchanged:' + why + ':' + cls)
        if (why === 'other') bad('spurious:' + cls)
      }
      o.prevEngine = es
      // E-55's tap
      if (o.calls > 0) { o.hits.e55.push(n); inc(S, 'e55:calls:' + cls, o.calls) }
      if (changed && o.calls === 0) inc(S, 'e55:missed:' + cls)
      if (!changed && o.calls > 0) {
        let why = 'equal-rewrite'
        if (L.length >= depth) {
          const id = L.slice(0, depth)
          const ps = w.recs.filter((x) => isPrefix(id, x.key)).map((x) => where(L, x.key))
          why = ps.length > 0 && ps.every((p) => p === 'beside') ? 'beside' : 'equal-at-above-or-below'
        }
        inc(S, 'e55:fired-unchanged:' + why + ':' + cls)
      }
      if (depth === 2 && L.length >= 2) for (const c of o.cs) if (c.changes.some((d) => d.key !== L[1])) { inc(S, 'e55:uncut-commit:' + cls); break }
      // the log: "under" against "at, above or below"
      if (anyNear) o.hits.near.push(n)
      if (anyUnder) o.hits.under.push(n)
      if (changed && !anyUnder) inc(S, 'log-under:missed:' + cls)
      if (changed && !anyNear) { if (through) inc(S, 'log-near:missed-through-string:' + cls); else bad('log-near:missed:' + cls) }
      if (!changed && anyNear) inc(S, 'log-near:unchanged:' + cls)
      if (!changed && anyUnder) inc(S, 'log-under:unchanged:' + cls)
      for (const x of w.recs) {
        if (MUT === 'nearbeside' && L.length > depth && x.key.length > depth && where(L, x.key) === 'beside' && isPrefix(L.slice(0, depth), x.key)) o.logMirror = x.t === 'remove' ? undefined : x.value
        else o.logMirror = foldNear(o.logMirror, L, x)
      }
      if (!deepEq(norm(L, o.logMirror), norm(L, mn))) { if (through) inc(S, 'log-near:fold-through-string:' + cls); else bad('log-near:fold:' + cls); o.logMirror = clone(mn) }
    }
    // in the shape run the model takes data's rows where they differ, so later checks stay meaningful
    if (shape) {
      for (const rec of w.recs) {
        const id = rec.key.slice(0, depth)
        if (!deepEq(rowOf(M2, depth, id), engineRow(store, depth, id))) { inc(S, 'shape-effect:model-differs:' + w.kind); M2 = engineHas(store, depth, id) ? putRow(M2, depth, id, clone(engineRow(store, depth, id))) : dropRow(M2, depth, id) }
      }
      for (const o of R) { o.logMirror = clone(modelAt(M2, depth, o.L)); o.mirror = o.L.length >= depth ? clone(engineAt(store, depth, o.L)) : engineAt(store, depth, o.L) }
    }
    // ── part 2: the clients' lenses ──
    for (let ci = 0; ci < 2; ci++) {
      const tag = ci === 0 ? 'wire' : 'road2'
      for (const o of CR[ci]) {
        const { L, cls } = o
        const mo = modelAt(M, depth, L), mn = modelAt(M2, depth, L)
        const changed = !deepEq(mo, mn)
        const es = engineAt(clients[ci], depth, L)
        const through = throughString([M, M2], depth, L)
        if (shape) { // what crosses JSON: does the client still equal the server?
          const now = !deepEq(es, engineAt(store, depth, L))
          if (now && !o.diverged) inc(S, tag + ':shape-client-differs-from-server:' + w.kind)
          o.diverged = now
          continue
        }
        if (!deepEq(es, mn)) bad(tag + ':state:' + cls)
        if (ci === 1) continue // road 2: the state only
        const fired = o.recs.length > 0
        if (L.length >= depth) for (const rec of o.recs) o.mirror = applyRel(o.mirror, rec)
        else for (const x of o.recs) o.mirror = applyDelta(o.mirror, x, depth, L)
        if (!deepEq(o.mirror, es)) { if (through) inc(S, tag + ':compose-through-string:' + cls); else bad(tag + ':compose:' + cls); o.mirror = clone(es) }
        if (changed && !fired && !through) bad(tag + ':missed:' + cls)
      }
    }
    M = M2
  }
  // -N: where `-1` and `-5` land under each reading
  for (const o of R) {
    for (const N of [1, 5]) {
      const at = (xs) => (xs.length >= N ? xs[xs.length - N] : 0)
      // against the commits that changed the value (truth), and against the commits data's reader fired on (data)
      for (const ref of ['truth', 'data']) for (const k of ['data', 'e55', 'near', 'under']) {
        if (k === ref) continue
        inc(S, `minusN:${N}:${k}-vs-${ref}:pairs:${o.cls}`)
        if (at(o.hits[k]) !== at(o.hits[ref])) inc(S, `minusN:${N}:${k}-vs-${ref}:differs:${o.cls}`)
      }
    }
    for (const k of ['truth', 'data', 'e55', 'near', 'under']) inc(S, `count:${k}:${o.cls}`, o.hits[k].length)
  }
  for (const o of R) { o.h.dispose(); o.tap.close() }
  for (const cr of CR) for (const o of cr) o.h.dispose()
  rootTap.close()
  return failed
}
