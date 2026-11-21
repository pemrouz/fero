// E-64 O4: a view sharded by its OUTPUT key, fed by routers on the source's copies. Seeded runs with an oracle.
//
// The view: per bucket of `user`, the row count, the exact sum of `cents`, the largest numeric `score` and the
// top 3 keys by score. Its buckets are hashed over K view SHARDS; a shard holds every row of its buckets (only
// the fields the view reads) in its own data store, so each bucket's answer is worked out on one shard, exactly,
// even when its best row leaves. No process holds every row, and no process folds every write.
//
// The rules under test (README.md, "The rules"):
//   O4-1 route   a ROUTER on a copy of each source group reads the copy's row deltas (before and after). For each
//                changed row it sends `leave(key)` to the shard of the OLD bucket and `row(key, fields)` to the
//                shard of the NEW bucket (one message when both are the same shard and the fields changed).
//   O4-2 chain   a router sends batches; a batch carries, per source slot it covers, the range (from, to] of that
//                slot's positions, to EVERY shard (an empty range part when no message is for that shard). A shard
//                applies a part only if `from` is at or below its own position for the slot, and then only the
//                messages past that position; a part ending at or below it is a duplicate; a part starting past
//                it is a GAP: the shard holds it and asks for a picture.
//   O4-3 picture a gap is healed by a PICTURE of the slot cut for this shard: the owner copy's rows of that slot
//                whose bucket hashes to this shard, at the slot's position P. It REPLACES every row of that slot
//                in the shard, as one commit of differences, if P is past the shard's position.
//   O4-4 hello   on every new link (a router restart, a group back from down, a shard moved or rebuilt), and when
//                a slot opens in a group, the router sends an empty part at the slot's head position, so a shard
//                behind on a quiet slot sees the gap.
//   O4-5 barrier (only for a read of the whole view at one cut) a coordinator reads a cut c of the source; each
//                shard applies up to c and holds the rest; a picture past c raises c for that slot, and every
//                shard catches up. When every shard is at c, their union is the view at c.
//
// Faults, from the seed: slot moves at the source; router crashes (the router's links' unsent tail is lost, the
// rest arrives later from a dead life, out of order: zombies); the router restarts at the HEAD of its group's
// log, with no history; shard crashes (state lost, rebuilt from pictures) and shard moves (state handed over,
// in-flight batches lost); one source group down for the middle half (--down=1); late and reordered pictures.
//
// The oracle, every 50 steps: each shard's rows equal the true rows at the shard's own cut whose bucket hashes to
// it, and each bucket's count, exact sum, max and top 3 equal a pure query over those rows. At a barrier, the
// union of the shards equals the view at the barrier's cut. At the end, after a drain, every shard is at the
// head and the union equals the view. Also counted: rows a whole-view read without a barrier would count twice
// or nowhere (shards at different cuts).
//
// Planted bugs (--mutate=): noleave (no leave to the old bucket's shard), nochain (apply every part), skipgap
// (on a gap, apply and jump instead of holding), nofilter (a chaining part re-applies messages at or below the
// shard's position), mergepic (a picture adds rows but removes none), nohello (no empty part at the head),
// barrierpass (shards do not hold at the barrier's cut), nobmark (lean form: no markers for a barrier's cut).
// --wire=lean sends parts only to shards with messages, plus markers (fence, open, hello, barrier): the cheap form.
import { World, D, NODE } from './world.mjs'
import { rng, out, proj, outKey, shardOf, Bucket, pureView, sameValue, canon } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'] }))
const SEEDS = +(args.seeds ?? 1), SEED0 = +(args.seed0 ?? 1), STEPS = +(args.steps ?? 1500)
const G = +(args.groups ?? 4), K = +(args.K ?? 4), DOM = args.dom ?? 'dirty', MUT = args.mutate ?? ''
const DOWN = args.down === '1', BARRIER = +(args.barrier ?? 0), W = +(args.W ?? 8), KEYS = +(args.keys ?? 600), BUCKETS = +(args.buckets ?? 20)
const WIRE = args.wire ?? 'full' // full: every part to every shard; lean: parts only where there are messages, plus markers
const CHECK = 50

class Shard {
  constructor(sim, k) { this.sim = sim; this.k = k; this.reset() }
  reset() {
    const S = this.sim.world.slots
    this.src = D.$({})
    this.node = this.src[NODE]
    this.lane = D.lane(this.src, { onReject: (rj) => { throw rj.error } })
    this.buckets = new Map()
    this.src.sink({ apply: (b) => { for (const d of b.rows) { if (d.op !== 'add') this.bucketAdd(d.key, d.prev, -1); if (d.op !== 'remove') this.bucketAdd(d.key, d.row, +1) } } })
    this.pos = new Int32Array(S)
    this.keysOfSlot = new Map()
    this.pending = new Map()
    this.wanted = new Set()
  }
  bucketAdd(k, p, sgn) {
    const b = outKey(p)
    if (b === undefined) return
    let bk = this.buckets.get(b)
    if (!bk) { bk = new Bucket(); this.buckets.set(b, bk) }
    bk.add(k, p, sgn)
    if (bk.n === 0) this.buckets.delete(b)
  }
  kos(s) { let x = this.keysOfSlot.get(s); if (!x) { x = new Set(); this.keysOfSlot.set(s, x) } return x }
  limit(s) { const B = this.sim.barrier; return B && MUT !== 'barrierpass' ? B.c[s] : Infinity }
  applyMsgs(s, msgs) {
    if (!msgs.length) return
    const recs = [], have = new Map(), kos = this.kos(s)
    const exists = (k) => (have.has(k) ? have.get(k) : this.node.rowAt(k) !== undefined)
    for (const m of msgs) {
      if (m.leave) { if (exists(m.k)) { recs.push({ type: 2, key: [m.k] }); have.set(m.k, false); kos.delete(m.k) } }
      else { recs.push(exists(m.k) ? { type: 0, key: [m.k], value: m.row } : { type: 1, key: [], at: m.k, value: m.row }); have.set(m.k, true); kos.add(m.k) }
    }
    if (recs.length) this.lane(recs)
    this.sim.st.msgsApplied += msgs.length
  }
  part(p) {
    const s = p.s, st = this.sim.st
    if (MUT === 'nochain') { this.applyMsgs(s, p.msgs); if (p.to > this.pos[s]) this.pos[s] = p.to; return }
    if (p.to <= this.pos[s]) { st.dup++; return }
    if (p.from > this.pos[s]) {
      if (MUT === 'skipgap') { this.applyMsgs(s, p.msgs.filter((m) => m.pos > this.pos[s])); this.pos[s] = p.to; return }
      st.gap++
      this.hold(p)
      this.want(s)
      return
    }
    const lim = this.limit(s)
    const keep = (m) => (MUT === 'nofilter' ? true : m.pos > this.pos[s])
    if (p.to > lim) { // the barrier: apply up to its cut, hold the rest
      this.applyMsgs(s, p.msgs.filter((m) => keep(m) && m.pos <= lim))
      if (lim > this.pos[s]) this.pos[s] = lim
      this.hold({ s, from: lim, to: p.to, msgs: p.msgs.filter((m) => m.pos > lim) })
      st.heldAtBarrier++
      return
    }
    this.applyMsgs(s, p.msgs.filter(keep))
    this.pos[s] = p.to
    this.retry(s)
  }
  hold(p) { let q = this.pending.get(p.s); if (!q) { q = []; this.pending.set(p.s, q) } q.push(p) }
  want(s) { if (this.wanted.has(s)) return; this.wanted.add(s); this.sim.askPicture(this.k, s) }
  retry(s) {
    const q = this.pending.get(s)
    if (!q) return
    this.pending.delete(s)
    q.sort((a, b) => a.from - b.from || a.to - b.to)
    for (const p of q) this.part(p) // a part that still gaps, or meets the barrier, is held again
    const r = this.pending.get(s)
    if (r && r.some((p) => p.from > this.pos[s])) this.want(s)
  }
  picture(s, P, rows) {
    const st = this.sim.st
    this.wanted.delete(s)
    if (P <= this.pos[s]) { st.picDropped++; this.retry(s); return }
    const want = new Map(rows), kos = this.kos(s), recs = []
    if (MUT !== 'mergepic') for (const k of kos) if (!want.has(k)) { recs.push({ type: 2, key: [k] }); kos.delete(k) }
    for (const [k, p] of want) { recs.push(this.node.rowAt(k) !== undefined ? { type: 0, key: [k], value: p } : { type: 1, key: [], at: k, value: p }); kos.add(k) }
    if (recs.length) this.lane(recs)
    this.pos[s] = P
    st.pictures++; st.pictureRows += rows.length
    const B = this.sim.barrier
    if (B && P > B.c[s]) this.sim.raiseCut(s, P) // the barrier's cut for this slot moves up; every shard catches up
    else this.retry(s)
  }
}

class Router {
  constructor(sim, g) {
    this.sim = sim; this.g = g; this.cur = 0; this.life = 0
    this.routed = new Map() // slot -> the highest position this router has routed (or said hello at)
    this.last = new Map() // lean form: slot * K + shard -> where the last part sent for that slot to that shard ended
    this.bpend = new Set() // lean form: slots that owe every shard a marker for the barrier's cut
    const w = sim.world
    for (let s = 0; s < w.slots; s++) if (w.owner[s] === g) { this.routed.set(s, 0); for (let k = 0; k < K; k++) this.last.set(s * K + k, 0) }
  }
  route(ch, pos, msgs) {
    const ko = ch.b === undefined ? -1 : (outKey(ch.b) === undefined ? -1 : shardOf(outKey(ch.b), K))
    const kn = ch.a === undefined ? -1 : (outKey(ch.a) === undefined ? -1 : shardOf(outKey(ch.a), K))
    const st = this.sim.st
    if (ko === kn && ko >= 0 && canon(ch.b) === canon(ch.a)) { st.unchanged++; return } // no field the view reads changed
    if (ko >= 0 && ko !== kn && MUT !== 'noleave') { (msgs[ko] ??= []).push({ k: ch.k, pos, leave: true }); st.msgs++; st.leaves++ }
    if (kn >= 0) { (msgs[kn] ??= []).push({ k: ch.k, pos, row: ch.a }); st.msgs++ }
    if (ko >= 0 && kn >= 0 && ko !== kn) st.crossShard++
  }
  // FULL form (the default): every part goes to every shard, with or without messages for it.
  // LEAN form (--wire=lean): a part goes only to shards with messages, and starts where the last part of that slot
  // sent to that shard ended; empty parts go only as markers: when a slot leaves (fence) or opens here, on hello,
  // and for a barrier once this router has routed past its cut.
  emitPart(out, p) {
    if (WIRE === 'full') { for (let k = 0; k < K; k++) out[k].push({ s: p.s, from: p.from, to: p.to, msgs: p.msgs[k] ?? [] }); return }
    for (let k = 0; k < K; k++) {
      const m = p.msgs[k]
      if (!m || !m.length) continue
      const key = p.s * K + k
      out[k].push({ s: p.s, from: this.last.get(key) ?? p.from, to: p.to, msgs: m })
      this.last.set(key, p.to)
    }
  }
  marker(out, s, to, fromOf) { // an empty part for slot s to every shard
    for (let k = 0; k < K; k++) { const key = s * K + k; out[k].push({ s, from: fromOf(key), to, msgs: [] }); this.last.set(key, to) }
    this.sim.st.markers += K
  }
  step() {
    const sim = this.sim, w = sim.world
    if (w.down.has(this.g)) return
    const stream = w.groups[this.g].stream
    const out = Array.from({ length: K }, () => [])
    const open = new Map() // slot -> its current part in this window
    const flush = (s) => { const p = open.get(s); if (p) { this.emitPart(out, p); open.delete(s) } }
    const n = this.cur < stream.length ? 1 + Math.floor(sim.r() * W) : 0
    for (let i = 0; i < n && this.cur < stream.length; i++) {
      const it = stream[this.cur++]
      if (it.kind === 'fence') { // the slot leaves this group
        flush(it.slot)
        if (WIRE === 'lean') this.marker(out, it.slot, it.pos, (key) => this.last.get(key) ?? it.pos)
        for (let k = 0; k < K; k++) this.last.delete(it.slot * K + k)
        this.routed.delete(it.slot); this.bpend.delete(it.slot)
        continue
      }
      if (it.kind === 'open') { // the slot arrives here at its carried position
        this.routed.set(it.slot, it.pos)
        for (let k = 0; k < K; k++) this.last.set(it.slot * K + k, it.pos)
        if (MUT !== 'nohello') this.marker(out, it.slot, it.pos, () => it.pos)
        if (sim.barrier && WIRE === 'lean') this.bpend.add(it.slot)
        continue
      }
      let p = open.get(it.slot)
      if (p && p.to !== it.pos - 1) { flush(it.slot); p = undefined }
      if (!p) { p = { s: it.slot, from: it.pos - 1, to: it.pos, msgs: [] }; open.set(it.slot, p) }
      p.to = it.pos
      for (const ch of it.ch) this.route(ch, it.pos, p.msgs)
      this.routed.set(it.slot, it.pos)
      sim.st.items++
    }
    for (const s of [...open.keys()]) flush(s)
    if (sim.barrier && WIRE === 'lean' && MUT !== 'nobmark') { // O4-5 in the lean form: a marker once routed past the cut
      for (const s of [...this.bpend]) {
        const r = this.routed.get(s)
        if (r === undefined) { this.bpend.delete(s); continue }
        if (r < sim.barrier.c[s]) continue
        this.marker(out, s, r, (key) => this.last.get(key) ?? r)
        this.bpend.delete(s)
      }
    }
    for (let k = 0; k < K; k++) if (out[k].length) { sim.send(this.g, k, { g: this.g, life: this.life, parts: out[k] }); sim.st.batches++ }
  }
  barrierStart() { if (WIRE === 'lean') for (const s of this.routed.keys()) this.bpend.add(s) }
  flushAll() { // lean form, end of a run: a marker at the routed position of every slot (a read at the head)
    const out = Array.from({ length: K }, () => [])
    for (const [s, r] of this.routed) this.marker(out, s, r, (key) => this.last.get(key) ?? r)
    for (let k = 0; k < K; k++) if (out[k].length) this.sim.send(this.g, k, { g: this.g, life: this.life, parts: out[k] })
  }
  hello(k) { // O4-4: an empty part at the position this router has routed to, for every slot this group holds
    if (MUT === 'nohello') return
    const parts = Array.from({ length: K }, () => [])
    const ks = k === undefined ? [...Array(K).keys()] : [k]
    // from: where the last part of that slot to that shard ended, if this life knows it (lean form), else r: a shard
    // behind r then sees a gap and takes a picture
    for (const [s, r] of this.routed) for (const kk of ks) { const key = s * K + kk; parts[kk].push({ s, from: WIRE === 'lean' ? this.last.get(key) ?? r : r, to: r, msgs: [] }); this.last.set(key, r) }
    for (const kk of ks) if (parts[kk].length) this.sim.send(this.g, kk, { g: this.g, life: this.life, parts: parts[kk] })
    this.sim.st.hellos += ks.length
  }
  crash() { // the unsent tail of each link is lost; the rest arrives later, from a dead life; restart at the head
    const sim = this.sim, w = sim.world
    for (let k = 0; k < K; k++) {
      const q = sim.links[this.g][k]
      const keepN = Math.floor(sim.r() * (q.length + 1))
      for (let i = 0; i < keepN; i++) sim.zombies.push({ k, batch: q[i] })
      sim.st.lostBatches += q.length - keepN
      sim.links[this.g][k] = []
    }
    this.life++
    this.cur = w.groups[this.g].stream.length
    this.routed.clear(); this.last.clear(); this.bpend.clear()
    for (let s = 0; s < w.slots; s++) if (w.owner[s] === this.g) this.routed.set(s, w.spos[s])
    if (sim.barrier) this.barrierStart()
    sim.st.routerCrashes++
    if (!w.down.has(this.g)) this.hello()
  }
}

class Sim {
  constructor(seed) {
    this.r = rng(seed * 104729 + 7)
    this.world = new World({ seed, G, keys: KEYS, dom: DOM, buckets: BUCKETS, moveEvery: 200 })
    this.shards = Array.from({ length: K }, (_, k) => new Shard(this, k))
    this.routers = Array.from({ length: G }, (_, g) => new Router(this, g))
    this.links = Array.from({ length: G }, () => Array.from({ length: K }, () => []))
    this.zombies = []
    this.asks = [] // picture requests waiting at the owners
    this.pics = [] // pictures on their way
    this.barrier = null
    this.st = { steps: 0, items: 0, msgs: 0, leaves: 0, crossShard: 0, unchanged: 0, batches: 0, hellos: 0, msgsApplied: 0, markers: 0, dup: 0, gap: 0, heldAtBarrier: 0, pictures: 0, pictureRows: 0, picDropped: 0, routerCrashes: 0, lostBatches: 0, zombiesDelivered: 0, shardCrashes: 0, shardMoves: 0, checks: 0, bad: 0, torn: 0, tornChecks: 0, rowsChecked: 0, lag: 0, barriers: 0, barrierSteps: 0, barrierMaxSteps: 0, barrierBad: 0, barrierStuck: 0 }
    this.firstBad = null
  }
  send(g, k, batch) { this.links[g][k].push(batch) }
  askPicture(k, s) { this.asks.push({ k, s }) }
  raiseCut(s, P) { this.barrier.c[s] = P; this.routers[this.world.owner[s]].bpend.add(s); for (const sh of this.shards) sh.retry(s) }
  newLinks(k) { for (const ro of this.routers) if (!this.world.down.has(ro.g)) ro.hello(k) }
  deliver() {
    const r = this.r
    for (let g = 0; g < G; g++) for (let k = 0; k < K; k++) { // each link delivers 0 to 2 batches a step, in order
      const q = this.links[g][k]
      const n = Math.floor(r() * 3)
      for (let i = 0; i < n && q.length; i++) { const b = q.shift(); for (const p of b.parts) this.shards[k].part(p) }
    }
    if (this.zombies.length && r() < 0.15) {
      const i = Math.floor(r() * this.zombies.length)
      const z = this.zombies.splice(i, 1)[0]
      for (const p of z.batch.parts) this.shards[z.k].part(p)
      this.st.zombiesDelivered++
    }
    // picture requests are served late, at the owner copy as it is then; pictures arrive late and out of order
    const serve = 2 + Math.floor(this.asks.length / 8) // a rebuild asks for every slot; owners answer in bulk
    for (let i = 0; i < serve && this.asks.length; i++) {
      const j = Math.floor(r() * this.asks.length), a = this.asks[j]
      if (this.world.down.has(this.world.owner[a.s])) continue
      this.asks.splice(j, 1)
      const rows = this.world.slotRows(a.s).filter(([, p]) => { const b = outKey(p); return b !== undefined && shardOf(b, K) === a.k })
      this.pics.push({ k: a.k, s: a.s, P: this.world.spos[a.s], rows })
    }
    const land = 2 + Math.floor(this.pics.length / 8)
    for (let i = 0; i < land && this.pics.length; i++) {
      if (r() < 0.5) continue
      const j = Math.floor(r() * this.pics.length), x = this.pics.splice(j, 1)[0]
      this.shards[x.k].picture(x.s, x.P, x.rows)
    }
  }
  faults(step) {
    const r = this.r, w = this.world
    if (r() < 1 / 300) this.routers[Math.floor(r() * G)].crash()
    if (r() < 1 / 900) { // a shard crash: state lost, in-flight batches to it lost; rebuilt from pictures
      const k = Math.floor(r() * K), sh = this.shards[k]
      sh.reset()
      for (let g = 0; g < G; g++) this.links[g][k] = []
      this.zombies = this.zombies.filter((z) => z.k !== k)
      this.pics = this.pics.filter((x) => x.k !== k); this.asks = this.asks.filter((a) => a.k !== k)
      for (let s = 0; s < w.slots; s++) sh.want(s)
      this.newLinks(k)
      this.st.shardCrashes++
    }
    if (r() < 1 / 700) { // a shard move: state handed to a new process; what was on its way to the old one is lost
      const k = Math.floor(r() * K)
      for (let g = 0; g < G; g++) this.links[g][k] = []
      this.zombies = this.zombies.filter((z) => z.k !== k)
      this.pics = this.pics.filter((x) => x.k !== k); this.asks = this.asks.filter((a) => a.k !== k)
      this.shards[k].wanted.clear()
      this.newLinks(k)
      this.st.shardMoves++
    }
    if (DOWN && G > 1) {
      if (step === Math.floor(STEPS / 4)) { // group 0 goes down: its links break (what was sent may still arrive)
        w.down.add(0)
        for (let k = 0; k < K; k++) { for (const b of this.links[0][k]) this.zombies.push({ k, batch: b }); this.links[0][k] = [] }
      }
      if (step === Math.floor((3 * STEPS) / 4)) { w.down.delete(0); this.routers[0].hello() }
    }
  }
  // ── the oracle ─────────────────────────────────────────────────────────────────────────────────────────
  expectedAt(cut, k) { // [key, proj] rows at a cut whose bucket hashes to shard k (k < 0: every row with a bucket)
    const w = this.world, rows = []
    for (const key of w.hist.keys()) {
      const row = w.rowAt(key, cut)
      if (row === undefined) continue
      const p = proj(row), b = outKey(p)
      if (b === undefined || (k >= 0 && shardOf(b, K) !== k)) continue
      rows.push([key, p])
    }
    return rows
  }
  shardRows(sh) { const m = new Map(); sh.node.each((k, row) => { m.set(k, row) }); return m }
  sameRows(have, want) {
    if (have.size !== want.length) return false
    for (const [k, p] of want) { const h = have.get(k); if (h === undefined || canon(h) !== canon(p)) return false }
    return true
  }
  sameView(buckets, pure) {
    if (buckets.size !== pure.size) return false
    for (const [b, v] of pure) { const bk = buckets.get(b); if (!bk || !sameValue(bk.value(), v)) return false }
    return true
  }
  checkShards(where) {
    this.st.checks++
    for (const sh of this.shards) {
      const want = this.expectedAt(sh.pos, sh.k)
      this.st.rowsChecked += want.length
      const ok = this.sameRows(this.shardRows(sh), want) && this.sameView(sh.buckets, pureView(want))
      if (!ok) { this.st.bad++; this.firstBad ??= { where, shard: sh.k, step: this.st.steps }; return false }
    }
    return true
  }
  torn() { // rows a whole-view read without a barrier counts twice or nowhere
    const w = this.world
    let n = 0
    const held = this.shards.map((sh) => sh.node)
    for (const key of w.hist.keys()) {
      let c = 0
      for (const nd of held) if (nd.rowAt(key) !== undefined) c++
      if (c >= 2) { n++; continue }
      if (c === 0) {
        let every = true
        for (const sh of this.shards) { const row = w.rowAt(key, sh.pos); if (row === undefined || outKey(proj(row)) === undefined) { every = false; break } }
        if (every) n++
      }
    }
    return n
  }
  barrierStep(step, final = false) {
    const B = this.barrier
    if (!B) { if (!final && BARRIER && step > 0 && step % BARRIER === 0) { this.barrier = { c: Int32Array.from(this.world.spos), start: step }; this.st.barriers++; for (const ro of this.routers) ro.barrierStart() } return }
    for (const sh of this.shards) for (let s = 0; s < this.world.slots; s++) if (MUT === 'barrierpass' ? sh.pos[s] < B.c[s] : sh.pos[s] !== B.c[s]) {
      if (final || step - B.start > 4 * STEPS) { this.st.barrierStuck++; this.st.bad++; this.firstBad ??= { where: 'barrier stuck', step }; this.release() }
      return
    }
    // every shard is at the cut: the union of the shards is the whole view at c
    this.st.barrierSteps += step - B.start
    if (step - B.start > this.st.barrierMaxSteps) this.st.barrierMaxSteps = step - B.start
    const want = this.expectedAt(B.c, -1)
    const have = new Map()
    for (const sh of this.shards) for (const [k, v] of this.shardRows(sh)) { if (have.has(k)) have.set(k, '#twice'); else have.set(k, v) }
    const union = new Map()
    for (const sh of this.shards) for (const [b, bk] of sh.buckets) union.set(b, bk)
    if (!this.sameRows(have, want) || !this.sameView(union, pureView(want))) { this.st.barrierBad++; this.st.bad++; this.firstBad ??= { where: 'barrier', step } }
    this.release()
  }
  release() { this.barrier = null; for (const sh of this.shards) for (const s of [...sh.pending.keys()]) sh.retry(s) }
  run() {
    const w = this.world, r = this.r
    for (let step = 1; step <= STEPS; step++) {
      this.st.steps = step
      if (G > 1 && r() < 1 / w.moveEvery) w.move()
      w.write()
      this.faults(step)
      for (const ro of this.routers) if (r() < 0.7) ro.step()
      this.deliver()
      this.barrierStep(step)
      if (step % CHECK === 0) {
        this.checkShards('periodic')
        const t = this.torn(); if (t) { this.st.torn += t; this.st.tornChecks++ }
        for (const sh of this.shards) for (let s = 0; s < w.slots; s++) this.st.lag += w.spos[s] - sh.pos[s]
      }
    }
    this.drain()
  }
  drain() { // no more writes or faults: route everything, deliver everything, serve every picture
    const w = this.world
    w.down.clear()
    if (this.barrier) { this.settle(); this.barrierStep(STEPS + 1, true) } // an open barrier must complete once all is delivered
    this.barrier = null
    this.settle()
    if (WIRE === 'lean') { for (const ro of this.routers) ro.flushAll(); this.settle() } // a read at the head
    this.endCheck()
  }
  settle() {
    const w = this.world
    for (let round = 0; round < 100000; round++) {
      let moved = false
      for (const ro of this.routers) { const before = ro.cur; ro.step(); if (ro.cur !== before) moved = true }
      for (let g = 0; g < G; g++) for (let k = 0; k < K; k++) while (this.links[g][k].length) { const b = this.links[g][k].shift(); for (const p of b.parts) this.shards[k].part(p); moved = true }
      while (this.zombies.length) { const z = this.zombies.shift(); for (const p of z.batch.parts) this.shards[z.k].part(p); moved = true }
      while (this.asks.length) { const a = this.asks.shift(); const rows = w.slotRows(a.s).filter(([, p]) => { const b = outKey(p); return b !== undefined && shardOf(b, K) === a.k }); this.pics.push({ k: a.k, s: a.s, P: w.spos[a.s], rows }); moved = true }
      while (this.pics.length) { const x = this.pics.shift(); this.shards[x.k].picture(x.s, x.P, x.rows); moved = true }
      for (const sh of this.shards) for (const s of [...sh.pending.keys()]) { const q = sh.pending.get(s); if (q && q.every((p) => p.to <= sh.pos[s])) sh.pending.delete(s) }
      if (!moved) break
    }
  }
  endCheck() {
    const w = this.world
    // at the end: every shard at the head of every slot, its rows and view right, and the union the whole view
    let atHead = true
    for (const sh of this.shards) for (let s = 0; s < w.slots; s++) if (sh.pos[s] !== w.spos[s]) atHead = false
    if (!atHead) { this.st.bad++; this.firstBad ??= { where: 'end: a shard behind the head' } }
    this.checkShards('end')
    if (this.torn()) { this.st.bad++; this.firstBad ??= { where: 'end: torn' } }
    if (w.checkCopies()) { this.st.bad++; this.firstBad ??= { where: 'world: copies unsound' } }
  }
}

const tot = { seeds: 0, failed: 0 }, sum = {}
let firstFail = null
for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
  const sim = new Sim(seed)
  sim.run()
  tot.seeds++
  if (sim.st.bad) { tot.failed++; firstFail ??= { seed, ...sim.firstBad } }
  for (const [k, v] of Object.entries(sim.st)) sum[k] = k === 'barrierMaxSteps' ? Math.max(sum[k] ?? 0, v) : (sum[k] ?? 0) + v
  for (const [k, v] of Object.entries(sim.world.st)) sum['w_' + k] = (sum['w_' + k] ?? 0) + v
}
out({ exp: "E-64", opt: "O4", run: "sim", wire: WIRE, groups: G, K, dom: DOM, down: DOWN, barrier: BARRIER, mutate: MUT || null, stepsPerSeed: STEPS, ...tot, firstFail, ...sum })
