// E-57 group A: the client side of a served view. One selection per distinct call in a process (equal calls share
// it, as equal lenses do in E-55). A selection keeps the value the user sees:
//   rows:    { kind: 'rows', rows: Map key -> row, order: [keys] }   (an ordered view keeps its order array)
//   buckets: { kind: 'buckets', map: Map bucket -> number }
//   scalar:  { kind: 'scalar', value }
// It applies a frame's records in order (removes, moves, adds at `at`, updates: data's wire application script) and a
// picture as ONE commit of differences against what it shows (XA-4). Each frame or picture makes one sink call with
// c = { diff: [{ type, key, row?, prev? }], order: [{ op: 'remove'|'move'|'insert', key, index?, from?, to? }] }.
// Class A (and class B served as A past views.shapes) keeps the partition in a local data source and runs the chain
// here, on data's real operators.
import { D, SourceNode, MUT, canon, buildChain, adapt } from './served.mjs'

const J = (x) => JSON.stringify(x)

export function emptyValue(kind) {
  if (kind === 'rows') return { kind: 'rows', rows: new Map(), order: [], ordered: true }
  if (kind === 'buckets') return { kind: 'buckets', map: new Map() }
  return { kind: 'scalar', value: undefined }
}
export function cloneValue(v) {
  if (v.kind === 'rows') return { kind: 'rows', rows: new Map(v.rows), order: [...v.order], ordered: v.ordered }
  if (v.kind === 'buckets') return { kind: 'buckets', map: new Map(v.map) }
  return { kind: 'scalar', value: v.value }
}
// apply c to a value (used to check XA-4: previous value + c = new value)
export function applyC(v, c) {
  if (v.kind === 'scalar') { for (const d of c.diff) v.value = d.next; return v }
  if (v.kind === 'buckets') { for (const d of c.diff) { if (d.type === 'remove') v.map.delete(d.key); else v.map.set(d.key, d.value) } return v }
  if (c.first) { v.rows.clear(); v.order.length = 0 }
  for (const d of c.diff) { if (d.type === 'remove') v.rows.delete(d.key); else v.rows.set(d.key, d.row) }
  applyOrderOps(v.order, c.order, c.diff)
  return v
}
// rebuild a list of keys from c alone (XA-5): order ops when c carries them; else removes, appends, no moves
export function applyOrderOps(list, ops, diff) {
  if (ops === undefined) {
    for (const d of diff) {
      if (d.type === 'remove') { const i = list.indexOf(d.key); if (i >= 0) list.splice(i, 1) }
      else if (d.type === 'add') list.push(d.key)
    }
    return list
  }
  for (const o of ops) {
    if (o.op === 'remove') { const i = list.indexOf(o.key); if (i >= 0) list.splice(i, 1) }
    else if (o.op === 'move') { const i = list.indexOf(o.key); if (i >= 0) list.splice(i, 1); list.splice(o.to, 0, o.key) }
    else list.splice(o.index, 0, o.key)
  }
  return list
}

// the difference between two values as one commit (a picture applied in place)
export function diffValues(prev, next) {
  const c = { diff: [], order: [] }
  if (next.kind === 'scalar') { if (!Object.is(prev.value, next.value)) c.diff.push({ type: 'set', prev: prev.value, next: next.value }); return c }
  if (next.kind === 'buckets') {
    for (const k of prev.map.keys()) if (!next.map.has(k)) c.diff.push({ type: 'remove', key: k })
    for (const [k, v] of next.map) if (!prev.map.has(k)) c.diff.push({ type: 'add', key: k, value: v }); else if (!Object.is(prev.map.get(k), v)) c.diff.push({ type: 'update', key: k, value: v })
    return c
  }
  const cur = [...prev.order]
  for (const k of prev.rows.keys()) if (!next.rows.has(k)) {
    c.diff.push({ type: 'remove', key: k, prev: prev.rows.get(k) })
    const i = cur.indexOf(k); if (i >= 0) { cur.splice(i, 1); c.order.push({ op: 'remove', key: k, index: i }) }
  }
  for (const [k, row] of next.rows) {
    if (!prev.rows.has(k)) c.diff.push({ type: 'add', key: k, row })
    else if (J(prev.rows.get(k)) !== J(row)) c.diff.push({ type: 'update', key: k, row, prev: prev.rows.get(k) })
  }
  const tgt = next.ordered === false ? cur : next.order
  for (let i = 0; i < tgt.length; i++) {
    if (cur[i] === tgt[i]) continue
    const j = cur.indexOf(tgt[i])
    if (j >= 0) { cur.splice(j, 1); cur.splice(i, 0, tgt[i]); c.order.push({ op: 'move', key: tgt[i], from: j, to: i }) }
    else { cur.splice(i, 0, tgt[i]); c.order.push({ op: 'insert', key: tgt[i], index: i }) }
  }
  return c
}

function pictureValue(kind, recs) {
  const v = emptyValue(kind)
  if (kind === 'scalar') { v.value = recs[0][1]; return v }
  if (kind === 'buckets') { for (const r of recs) v.map.set(r[1], r[2]); return v }
  const ordered = recs.length > 0 && recs[0][3] !== undefined
  for (const r of recs) v.rows.set(r[1], r[2])
  v.order = ordered ? recs.map((r) => r[1]) : []
  v.ordered = ordered || recs.length === 0
  return v
}

let clientLinks = 0
export class Client {
  constructor(w, id, opts = {}) {
    this.w = w; this.id = id; this.claims = opts.claims ?? { sub: 'u' + id }
    this.sels = new Map(); this.byH = new Map(); this.byInst = new Map(); this.gets = new Map(); this.calls = new Map()
    this.seen = 0; this.hs = 0; this.ids = 0
    this.minVer = {} // XA-10: the highest version seen per method
    this.shapes = opts.shapes ?? null // a typed client: method -> the shape it was compiled for (null: it fetches the table)
  }
  keyOf(spec) { return spec.cls === 'B' ? 'B|' + spec.part + '|' + canon(spec.ops) : spec.cls === 'A' ? 'A|' + spec.part + '|' + canon(spec.ops ?? []) : 'C|' + spec.method + '|' + canon(spec.arg) }
  open(spec) {
    const key = this.keyOf(spec)
    let s = this.sels.get(key)
    if (s) { s.refs++; this.w.stats.clientShares++; return s }
    s = { key, spec, cls: spec.cls, refs: 1, h: ++this.hs, status: 'new', copy: null, inst: null, q: 0, own: 0, pos: -1, ver: 0, value: null, kind: null, sinks: 0, asA: false, local: null, held: false, shadow: [], retryAt: 0 }
    this.sels.set(key, s); this.byH.set(s.h, s)
    this.subscribe(s, false)
    return s
  }
  close(s) {
    if (--s.refs > 0) return
    this.sels.delete(s.key); this.byH.delete(s.h)
    this.unbind(s)
    const was = s.status
    s.status = 'closed'
    if (s.copy !== null && (was === 'up' || was === 'sub')) this.w.toCopy(this, s.copy, { t: 'unsub', h: s.h }, false)
  }
  subscribe(s, resume) {
    const target = this.w.route(this, s)
    if (target === null) { s.status = 'wait'; s.retryAt = this.w.t + 2; return }
    s.copy = target; s.status = 'sub'
    if (s.cls === 'B') s.asA = false // the copy says again if it serves this as class A
    const sp = s.spec
    const m = { t: 'sub', h: s.h, cls: s.cls === 'A' ? 'A' : s.cls, method: sp.method, arg: sp.arg, part: sp.part, ops: sp.ops, place: this.w.placeKey(s), seen: this.seen, claims: this.claims, minVer: { ...this.minVer }, held: s.held }
    if (this.shapes && sp.method) m.shape = this.shapes[sp.method]
    if (resume && s.inst !== null) m.resume = { inst: s.inst, seq: MUT.has('ownseq') ? s.own : s.q }
    this.w.stats.subs++
    if (resume) this.w.stats.resubs++
    this.w.toCopy(this, target, m, true)
  }
  get(spec) {
    const h = ++this.hs, target = this.w.route(this, { cls: 'C', spec, key: this.keyOf(spec) })
    if (target === null) return
    this.gets.set(h, { spec, copy: target })
    this.w.toCopy(this, target, { t: 'get', h, cls: 'C', method: spec.method, arg: spec.arg, place: this.w.placeKey({ cls: 'C', spec, key: this.keyOf(spec) }), seen: this.seen, claims: this.claims, minVer: { ...this.minVer } }, true)
  }
  linkDown(copyId) {
    for (const s of this.sels.values()) if (s.copy === copyId && (s.status === 'up' || s.status === 'sub')) { s.status = 'down'; s.retryAt = this.w.t + 1 + (this.w.r() % this.w.cfg.downFor) }
    for (const [h, g] of this.gets) if (g.copy === copyId) this.gets.delete(h)
  }
  tick(t) {
    for (const s of [...this.sels.values()]) if ((s.status === 'down' || s.status === 'wait') && t >= s.retryAt) this.subscribe(s, true)
  }
  setPos(s, p) {
    const st = this.w.stats
    if (p < s.pos) { st.backInTime++; this.w.fail('backInTime', s) }
    s.pos = p
    if (p > this.seen) this.seen = p
  }
  noteVer(s, v) {
    const m = s.spec.method
    if (!m) return
    const seen = this.minVer[m] ?? 0
    if (v < seen) { this.w.stats.versionBack++; this.w.fail('versionBack', s) }
    if (v > seen) this.minVer[m] = v
    s.ver = v
  }
  onMsg(copyId, raw) {
    const st = this.w.stats
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof raw === 'string') st.decodes++
    if (m.t === undefined) return this.onFrame(copyId, m)
    if (m.t === 'ret') { const c = this.calls.get(m.id); this.calls.delete(m.id); if (c) this.w.checkCall(this, c, m); return }
    if (m.t === 'pic' && m.get) { const g = this.gets.get(m.h); this.gets.delete(m.h); if (g && g.copy === copyId) this.w.checkGet(this, g, m); return }
    if (m.t === 'ref' && this.gets.has(m.h)) { this.gets.delete(m.h); st.getRefused++; if (m.code === 'too-many-views') st.getTooMany++; return }
    if (m.t === 'end' && this.gets.has(m.h)) { const g = this.gets.get(m.h); this.gets.delete(m.h); if (m.reason === 'moved') st.getMoved++; return }
    const s = this.byH.get(m.h)
    if (!s || s.copy !== copyId) { st.stale++; return }
    if (m.t === 'pic') return this.onPicture(s, m)
    if (m.t === 'asA') { s.asA = true; return }
    if (m.t === 'res') {
      if (MUT.has('noinstance') && m.i !== s.inst) { this.unbind(s); s.inst = m.i; this.bind(s) }
      s.status = 'up'; st.clientRingResumes++
      for (const f of m.f) this.onFrameSel(copyId, f, s) // the ring frames after the client's sequence
      if (!MUT.has('ownseq') && m.q !== s.q) st.resumeSeqMismatch++
      this.setPos(s, m.p)
      this.w.check(this, s, 'resume', null)
      return
    }
    if (m.t === 'sync') { if (s.status === 'up') { this.setPos(s, Math.max(s.pos, m.p)); this.w.checkSync(this, s, m) } return }
    if (m.t === 'end') {
      st['end_' + m.reason] = (st['end_' + m.reason] ?? 0) + 1
      if (m.reason === 'moved' || m.reason === 'redeployed') {
        if (m.reason === 'redeployed' && this.shapes === null) {} // an untyped client fetches the new table and subscribes again
        this.subscribe(s, true)
      } else s.status = 'ended'
      return
    }
    if (m.t === 'ref') {
      st['ref_' + m.code] = (st['ref_' + m.code] ?? 0) + 1
      if (m.code === 'retry') { s.status = 'wait'; s.retryAt = this.w.t + 2 }
      else { s.status = 'refused'; this.w.onRefused(this, s, m) }
    }
  }
  bind(s) { let set = this.byInst.get(s.inst); if (!set) this.byInst.set(s.inst, (set = new Set())); set.add(s) }
  unbind(s) { if (s.inst === null) return; const set = this.byInst.get(s.inst); if (set) { set.delete(s); if (!set.size) this.byInst.delete(s.inst) } }
  onFrame(copyId, f) {
    const set = this.byInst.get(f.i)
    if (!set) { this.w.stats.framesDropped++; return }
    for (const s of [...set]) this.onFrameSel(copyId, f, s)
  }
  onFrameSel(copyId, f, s) {
    const st = this.w.stats
    if (!s || s.copy !== copyId || s.status !== 'up') { st.framesDropped++; return }
    if (this.belowFloor(s, f.v)) return
    if (!MUT.has('ownseq')) {
      if (f.q <= s.q) { st.dupFrames++; return }
      if (f.q !== s.q + 1) { st.gaps++; this.w.fail('gap', s); this.subscribe(s, true); return }
      s.q = f.q
    } else s.own++
    this.noteVer(s, f.v)
    this.setPos(s, f.p)
    st.framesApplied++
    if (s.asA || s.cls === 'A') this.applyLocal(s, f.r)
    else this.applyRecs(s, f.r)
  }
  // a frame's records onto a served value, with the order channel; one sink call
  applyRecs(s, recs) {
    const v = s.value, st = this.w.stats
    const c = { diff: [], order: MUT.has('noorderc') ? undefined : [] }
    const keyed = MUT.has('keyedcopy')
    for (const r of recs) {
      const t = r[0]
      if (v.kind === 'scalar') { c.diff.push({ type: 'set', prev: v.value, next: r[1] }); v.value = r[1]; continue }
      if (v.kind === 'buckets') {
        if (t === 'x') { if (!v.map.has(r[1])) st.missed++; v.map.delete(r[1]); c.diff.push({ type: 'remove', key: r[1] }) }
        else { c.diff.push({ type: v.map.has(r[1]) ? 'update' : 'add', key: r[1], value: r[2] }); v.map.set(r[1], r[2]) }
        continue
      }
      const k = r[1]
      if (t === 'r') {
        if (!v.rows.has(k)) { st.missed++; this.w.fail('missed', s) }
        const prev = v.rows.get(k); v.rows.delete(k)
        const i = v.order.indexOf(k); if (i >= 0) v.order.splice(i, 1)
        c.diff.push({ type: 'remove', key: k, prev }); c.order?.push({ op: 'remove', key: k, index: i })
      } else if (t === 'm') {
        if (keyed) continue
        const i = v.order[r[2]] === k ? r[2] : v.order.indexOf(k)
        if (i >= 0) v.order.splice(i, 1)
        v.order.splice(r[3], 0, k)
        c.order?.push({ op: 'move', key: k, from: r[2], to: r[3] })
      } else if (t === 'a') {
        if (v.rows.has(k)) { st.doubled++; this.w.fail('doubled', s) }
        v.rows.set(k, r[2])
        const at = keyed || r[3] === undefined ? v.order.length : r[3]
        if (v.ordered !== false) v.order.splice(at, 0, k)
        c.diff.push({ type: 'add', key: k, row: r[2] }); c.order?.push({ op: 'insert', key: k, index: at })
      } else if (t === 'u') {
        if (!v.rows.has(k)) { st.missed++; this.w.fail('missed', s) }
        const prev = v.rows.get(k)
        const row = r[3] ? { ...prev, [r[3][0]]: r[2] } : r[2]
        v.rows.set(k, row)
        c.diff.push({ type: 'update', key: k, row, prev })
      }
    }
    if (keyed && v.kind === 'rows') v.order = [...v.rows.keys()]
    this.sink(s, c, 'frame')
  }
  // XA-10: a client never shows a method below the highest version it has seen (found by XA-10's sim: another selection
  // of the same method, still on a copy not yet upgraded, kept showing v1 after this client saw v2). Such a frame or
  // picture is dropped and the selection subscribes again with its floor; a copy below the floor answers `retry`.
  belowFloor(s, v) {
    const m = s.spec.method
    if (!m || MUT.has('tableversion') || v >= (this.minVer[m] ?? 0)) return false
    this.w.stats.belowFloor = (this.w.stats.belowFloor ?? 0) + 1
    if (s.status === 'up' || s.status === 'sub') this.w.toCopy(this, s.copy, { t: 'unsub', h: s.h }, false)
    this.unbind(s); s.status = 'wait'; s.retryAt = this.w.t + 2
    return true
  }
  onPicture(s, m) {
    const st = this.w.stats
    if (this.belowFloor(s, m.v)) return
    if (s.asA || s.cls === 'A') { s.wasAsA = true; return this.pictureLocal(s, m) }
    if (s.wasAsA) { s.wasAsA = false; s.shadow = s.value && s.value.kind === 'rows' ? [...s.value.order] : [] }
    const next = pictureValue(m.k, m.r)
    s.kind = m.k
    const prev = s.value ?? emptyValue(m.k)
    let c
    if (MUT.has('wholesale')) {
      c = { first: true, diff: [], order: [] }
      if (prev.kind === 'rows') { for (const [k, row] of prev.rows) c.diff.push({ type: 'remove', key: k, prev: row }); for (const [k, row] of next.rows) c.diff.push({ type: 'add', key: k, row }); next.order.forEach((k, i) => c.order.push({ op: 'insert', key: k, index: i })) }
      else c = diffValues(emptyValue(m.k), next)
    } else c = diffValues(prev, next)
    if (MUT.has('noorderc')) c.order = undefined
    // XA-4: previous value + c = new value; no change entry for an unchanged row
    if (s.value !== null && prev.kind === next.kind) {
      const back = applyC(cloneValue(prev), c.order === undefined ? { ...c, order: diffValues(prev, next).order } : c)
      if (!sameValue(back, next)) { st.xa4Unequal++; this.w.fail('xa4', s) }
      if (prev.kind === 'rows') for (const d of c.diff) if (d.type !== 'add' && d.type !== 'remove' && J(d.prev) === J(d.row)) st.xa4Unchanged++
      if (prev.kind === 'rows') for (const d of c.diff) if ((d.type === 'remove' && next.rows.has(d.key) && J(next.rows.get(d.key)) === J(d.prev)) || (d.type === 'add' && prev.rows.has(d.key) && J(prev.rows.get(d.key)) === J(d.row))) { st.xa4Unchanged++; this.w.fail('xa4unchanged', s) }
    }
    if (MUT.has('picorder') && s.value !== null && prev.kind === 'rows' && next.order.length) {
      // planted (A7 b): the picture replaces the rows but keeps the old order array (present keys), new keys appended
      const keep = prev.order.filter((k) => next.rows.has(k))
      for (const k of next.order) if (!keep.includes(k)) keep.push(k)
      next.order = keep
    }
    this.unbind(s)
    s.inst = m.i; this.bind(s)
    s.q = m.q; s.own = 0
    s.value = next
    s.held = true
    s.status = 'up'
    st.clientPictures++
    this.noteVer(s, m.v)
    this.setPos(s, m.p)
    this.sink(s, c, 'pic')
  }
  // ── class A, and class B served as A: a local data source and the chain run here ──
  ensureLocal(s) {
    if (s.local) return s.local
    const rt = new D.Runtime(), src = new SourceNode(rt, {})
    const ops = s.spec.ops ?? []
    const view = ops.length ? adapt(buildChain(D.handleFor(src), ops)) : null
    return (s.local = { rt, src, view })
  }
  readLocal(s) {
    const L = s.local
    if (!L.view) { const v = emptyValue('rows'); L.src.each((k, row) => v.rows.set(k, row)); return v }
    if (L.view.kind === 'scalar') return { kind: 'scalar', value: L.view.picture()[0][1] }
    const recs = L.view.picture()
    const v = emptyValue('rows')
    for (const r of recs) v.rows.set(r[1], r[2])
    v.order = recs.length && recs[0][3] !== undefined ? recs.map((r) => r[1]) : []
    return v
  }
  applyLocal(s, recs) {
    const L = this.ensureLocal(s), st = this.w.stats
    L.rt.batch(() => {
      for (const r of recs) {
        if (r[0] === 'r') { if (L.src.get(r[1]) === undefined) st.missed++; else L.src.remove(r[1]) }
        else if (r[0] === 'a') { if (L.src.get(r[1]) !== undefined) st.doubled++; L.src.write(r[1], [], r[2]) }
        else L.src.write(r[1], [], r[2])
      }
    })
    const prev = s.value ?? emptyValue('rows')
    s.value = this.readLocal(s)
    this.sink(s, diffValues(prev.kind === s.value.kind ? prev : emptyValue(s.value.kind), s.value), 'frame')
  }
  pictureLocal(s, m) {
    const L = this.ensureLocal(s)
    const want = new Map(m.r.map((r) => [r[1], r[2]]))
    L.rt.batch(() => { // the picture as one commit of differences on the local store
      const gone = []
      L.src.each((k) => { if (!want.has(k)) gone.push(k) })
      for (const k of gone) L.src.remove(k)
      for (const [k, row] of want) if (J(L.src.get(k)) !== J(row)) L.src.write(k, [], row)
    })
    const prev = s.value ?? null
    s.value = this.readLocal(s)
    s.kind = s.value.kind
    this.unbind(s)
    s.inst = m.i; this.bind(s); s.q = m.q; s.own = 0; s.held = true; s.status = 'up'
    this.w.stats.clientPictures++
    this.setPos(s, m.p)
    this.sink(s, diffValues(prev && prev.kind === s.value.kind ? prev : emptyValue(s.value.kind), s.value), 'pic')
  }
  sink(s, c, why) {
    const st = this.w.stats
    s.sinks++; st.sinkCalls++
    if (s.status === 'ended' || s.status === 'refused' || s.status === 'closed') { st.sinkAfterEnd++; this.w.fail('sinkAfterEnd', s) }
    // XA-5: a list rebuilt from c alone
    if (s.value && s.value.kind === 'rows' && s.value.order.length + s.shadow.length > 0 && !(s.asA || s.cls === 'A')) {
      if (c.first) s.shadow = []
      applyOrderOps(s.shadow, c.order, c.diff)
      if (J(s.shadow) !== J(s.value.order)) { st.xa5Unequal++; this.w.fail('xa5', s); s.shadow = [...s.value.order] }
    }
    this.w.check(this, s, why, c)
  }
}

export function sameValue(a, b) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'scalar') return Object.is(a.value, b.value)
  if (a.kind === 'buckets') { if (a.map.size !== b.map.size) return false; for (const [k, v] of a.map) if (!Object.is(v, b.map.get(k))) return false; return true }
  if (J(a.order) !== J(b.order) || a.rows.size !== b.rows.size) return false
  for (const [k, r] of a.rows) if (J(r) !== J(b.rows.get(k))) return false
  return true
}
