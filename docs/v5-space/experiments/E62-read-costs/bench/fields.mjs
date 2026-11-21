// E-62 item 1: what `c.version`, `c.cursor` and a diff entry's `version` cost a commit when read (V5-13; CONNECT 9;
// bar 50 ns a commit). E-55 claim 10's interleaved harness (bench/connect.mjs `tap2`): 10,000 rows, field writes over
// every row (100,000 a round, 21 rounds), one tap, the ways interleaved round by round, differences taken inside a
// round. Unlike tap2, every way runs on ONE resource and ONE tap, and only switches what the tap reads (see below).
//   node --expose-gc --experimental-strip-types fields.mjs <part: part | whole | alone>
// part   depth 2, ONE room of 10,000 rows, the tap on the room: a link inside one partition, where c.version exists
// whole  depth 1, 10,000 rows, the tap on the whole resource (claim 10's own shape): only c.cursor exists there, one
//        (epoch, sequence) per slot the link reads, 4,096 slots
// alone  each field built alone on captured commit objects in a tight loop, as E-56 probe 3's "alone" column
// E-55's prototype has no log and no positions. The stand-in: the writer makes each write's frame header (its slot, the
// slot's epoch and sequence) before the write, as a leader's frame would carry it, and E-55's delivery is replaced in
// this process only (its file is not edited) by one that hands the header to the commit object. One record per commit.
//   c.version   the commit's version as text, built when first read (E-56's length-prefixed base32, no BigInt), at
//               epoch 0 (the shortest text) and at epoch 3 (any slot that has moved, been restored or recovered
//               uncleanly); at epoch 3 also with the epoch's digits made once per slot (common.mjs vtextP)
//   c.cursor    one partition, two text forms, each kept on the commit when first read and made one flat string:
//               E-56's 21-26 byte cursor as base64url; or the link's own prefix (id and slot, made once per link)
//               followed by the version text, another format (a DEV-09 choice). Whole resource, four ways:
//               text   the selection keeps one sequence per slot (Float64Array(4096)) and each read builds E-19's
//                      delta-coded text from it (valid only inside the call: a later read would see later commits)
//               copy   the same array, copied when read (a frozen place, 32 KB)
//               trie   a persistent 16-ary trie of the 4,096 sequences, path-copied per record; a read takes its root
//                      (a place you may keep), and its text is built only when you save it ("trie+text")
//   c.diff[i].version  fero's diff entries (E-56 probe 3 built them at 21-29 ns), each with a lazy version
import { fero, Sel, Store, toRecs } from '../../E55-lens-prototype/proto/lens.mjs'
import { seedRows, key, out, interleave, vtext, vtextBig, vtextP, eprefix, cursor1, cursor1fast, cursorWhole, decodeWhole, slotOf, rng, RID, flat, flatSinkUsed } from './common.mjs'

const PART = process.argv[2] ?? 'part'
const N = 10000, W = +(process.env.WRITES ?? 100000), ROUNDS = +(process.env.ROUNDS ?? 21)
let sink = 0

// ── the frame header the writer hands down (a leader's frame carries it) ──
const H = { epoch: 0, seq: 0, slot: 0 }
const slotSeq = new Float64Array(4096)

// ── a persistent trie of 4,096 sequences: 16 × 16 × 16, path-copied per update ──
const T_EMPTY = (() => { const l2 = () => new Array(16).fill(0); const l1 = () => { const a = new Array(16); for (let i = 0; i < 16; i++) a[i] = l2(); return a }; const a = new Array(16); for (let i = 0; i < 16; i++) a[i] = l1(); return a })()
function trieSet(root, slot, v) {
  const a = slot >>> 8, b = (slot >>> 4) & 15, c = slot & 15
  const r = root.slice(), m = r[a].slice(), leaf = m[b].slice()
  leaf[c] = v; m[b] = leaf; r[a] = m
  return r
}
function trieFlat(root) { const o = new Float64Array(4096); for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) { const l = root[a][b]; for (let c = 0; c < 16; c++) o[(a << 8) | (b << 4) | c] = l[c] } return o }

// ── a diff entry: fero's own object per change, with a version built when read ──
class DiffEntry {
  constructor(c, d) { this.c = c; this.type = d.op; this.key = d.key; this.partition = d.part ?? c.prefix ?? d.key; this.row = d.row; this.prev = d.prev; this._v = null }
  // one record per commit here, so the entry's version is the commit's record; built from the numbers, not shared
  get version() { return this._v ??= vtext(this.c.ep, this.c.sq) }
}
// E-55's Commit, copied (its file is not edited), as two classes of this file: one with no header (the reference)
// and one with the header's three numbers. Everything else is built when read.
class FCommit0 {
  constructor(sel, deltas, seq, first, prefix) {
    this.sel = sel; this.seq = seq; this.first = first; this._d = deltas; this._recs = null; this._text = null
    this.prefix = prefix === undefined ? sel.prefix : prefix
  }
  get changes() { return this._d === null ? (this._d = this.sel.pictureDeltas()) : this._d }
  get now() { return this.sel.view }
  recs() { if (this._recs === null) { this._recs = toRecs(this.changes, this.prefix); this.sel.eng.stats.recs++ } return this._recs }
  text() { if (this._text === null) { this._text = JSON.stringify(this.recs()); this.sel.eng.stats.texts++ } return this._text }
}
class VCommit {
  constructor(sel, deltas, seq, first, prefix, ep, sq, sl, pos) {
    this.sel = sel; this.seq = seq; this.first = first; this._d = deltas; this._recs = null; this._text = null
    this.prefix = prefix === undefined ? sel.prefix : prefix
    this.ep = ep; this.sq = sq; this.sl = sl; this.pos = pos; this._v = null; this._c = null; this._diff = null
  }
  get changes() { return this._d === null ? (this._d = this.sel.pictureDeltas()) : this._d }
  get now() { return this.sel.view }
  recs() { if (this._recs === null) { this._recs = toRecs(this.changes, this.prefix); this.sel.eng.stats.recs++ } return this._recs }
  text() { if (this._text === null) { this._text = JSON.stringify(this.recs()); this.sel.eng.stats.texts++ } return this._text }
  get version() { return this._v ??= vtext(this.ep, this.sq) }
  // the same text with the slot's epoch digits made once (valid above epoch 0 only)
  get versionP() { return this._v ??= vtextP(this.sel.e62.epre, this.sq) }
  get cursor() {
    if (this._c !== null) return this._c
    const m = this.sel.e62.mode
    if (m === 'one') return (this._c = cursor1(this.sl, this.ep, this.sq))
    if (m === 'prefix') return (this._c = flat(this.sel.e62.pre + vtext(this.ep, this.sq)))
    if (m === 'text') return (this._c = cursorWhole(this.sel.e62.pos))
    if (m === 'copy') return (this._c = this.sel.e62.pos.slice())
    return (this._c = this.pos) // trie: the root as it was right after this commit
  }
  get diff() {
    if (this._diff !== null) return this._diff
    const ds = this.changes, o = new Array(ds.length)
    for (let i = 0; i < ds.length; i++) o[i] = new DiffEntry(this, ds[i])
    return (this._diff = o)
  }
}

// every selection gets the same extra field right after it is made, so all have one shape
const makeSel0 = Store.prototype.makeSel
Store.prototype.makeSel = function (part) { const s = makeSel0.call(this, part); s.e62 = null; return s } // null: no header kept
// E-55's Sel.deliver, line for line, plus: the positions upkeep when kept, and the header handed to the commit
Sel.prototype.deliver = function (deltas, seq, prefix) {
  this.seq = seq
  const x = this.e62
  if (x !== null) {
    if (x.mode === 'text' || x.mode === 'copy' || x.mode === 'pos') x.pos[H.slot] = H.seq
    else if (x.mode === 'trie') x.root = trieSet(x.root, H.slot, H.seq)
  }
  const ls = this.links
  if (ls.length === 0) return
  const c = x === null ? new FCommit0(this, deltas, seq, false, prefix) : new VCommit(this, deltas, seq, false, prefix, H.epoch, H.seq, H.slot, x.mode === 'trie' ? x.root : null)
  for (let i = 0; i < ls.length; i++) { const L = ls[i]; if (L.dead === false) L.feed(c) }
}

// ── the ways ──
const keys = Array.from({ length: N }, (_, i) => key(i))
const kslot = Int32Array.from(keys, (k) => slotOf(k))
const RSLOT = slotOf('p') // the room's slot
// writes: the row cycles over every row; the header's sequence rises by 1 to 3 (other partitions share the slot)
const gap = Uint8Array.from({ length: 4096 }, (_, i) => 1 + (i % 3))

// ── alone: each field built on captured commit objects in a tight loop (as E-56 probe 3's "alone"), against a pass
// that only clears the cache; 7 passes interleaved, the median of the in-pass differences ──
if (PART === 'alone') {
  const M = 100000
  const ck = rng(63)
  const LINKPRE = RID.toString('base64url') + '.' + RSLOT + '.' // made once per link
  const EPRE3 = eprefix(3) // made once per slot and epoch
  const selOne = { e62: { mode: 'one', pre: LINKPRE, epre: EPRE3 }, prefix: 'p' }
  const mkc = (ep) => { const cs = new Array(M); for (let i = 0; i < M; i++) { const k = keys[i % N]; cs[i] = new VCommit(selOne, [{ op: 'update', key: k, row: { n: i }, prev: { n: i - 1 }, path: ['n'] }], i, false, 'p', ep, 1e6 + i * 3, RSLOT, null) } for (const c of cs) c.diff; return cs }
  const c0 = mkc(0), c3 = mkc(3) // epoch 0, and epoch 3 (a slot that has moved)
  // every pass clears what the commit keeps (its version, cursor and entry's version), then builds one field; the
  // cursors and versions are kept on the commit, as the getters keep them, and the string cursors are made flat
  const pass = (cs, body) => () => { for (let i = 0; i < M; i++) { const c = cs[i]; c._v = null; c._c = null; c._diff0 = c._diff; c.diff[0]._v = null; sink = (sink + body(c)) & 1023 } return M }
  const ways = {
    clear: pass(c0, () => 0),
    clear3: pass(c3, () => 0),
    version: pass(c0, (c) => c.version.length),
    version3: pass(c3, (c) => c.version.length),
    version3p: pass(c3, (c) => c.versionP.length),
    bigint: pass(c0, (c) => vtextBig(c.ep, c.sq).length),
    cursor: pass(c0, (c) => c.cursor.length),
    cursor3: pass(c3, (c) => c.cursor.length),
    // the same E-56 text with the id's fixed part made once (common.mjs cursor1fast), kept and made flat
    cursorfast: pass(c0, (c) => (c._c = flat(cursor1fast(c.sl, c.ep, c.sq))).length),
    // another format: the link's own prefix (id and slot, made once per link) and the version text, kept and made flat
    cursorprefix: pass(c0, (c) => (c._c = flat(LINKPRE + vtext(c.ep, c.sq))).length),
    cursorprefix3: pass(c3, (c) => (c._c = flat(LINKPRE + vtext(c.ep, c.sq))).length),
    entry: pass(c0, (c) => c.diff[0].version.length),
    entry3: pass(c3, (c) => c.diff[0].version.length),
    diffbuild: pass(c0, (c) => { c._diff = null; const n = c.diff.length; c._diff = c._diff0; c.diff[0]._v = null; return n }),
  }
  const r = interleave(ways, { rounds: 7, ops: M })
  let fastBad = 0; for (let i = 0; i < 100000; i++) { const sl = i % 4096, e = i % 7 === 0 ? i % 300 : 0, sq = Math.floor(ck() * 2 ** (1 + (i % 40))); if (cursor1(sl, e, sq) !== cursor1fast(sl, e, sq)) fastBad++ }
  let pBad = 0; for (let i = 0; i < 1e6; i++) { const e = 1 + Math.floor(ck() * 8000), sq = Math.floor(ck() * 2 ** (1 + (i % 40))); if (vtextP(eprefix(e), sq) !== vtext(e, sq)) pBad++ }
  // whole resource: the text from 4,096 sequences, a copy, one trie update, one trie read; per op, 7 passes
  const per = (fn, n) => { const xs = []; for (let k = 0; k < 7; k++) { const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(i); xs.push(Number(process.hrtime.bigint() - t0) / n) } xs.sort((a, b) => a - b); return { med: Math.round(xs[3] * 10) / 10, lo: Math.round(xs[0] * 10) / 10, hi: Math.round(xs[6] * 10) / 10 } }
  const pos = new Float64Array(4096); for (let i = 0; i < 4096; i++) pos[i] = 2000 + ((i * 7919) % 500)
  let root = T_EMPTY; for (let i = 0; i < 4096; i++) root = trieSet(root, i, pos[i])
  let rt = root
  const whole = {
    text: per(() => { sink = (sink + cursorWhole(pos).length) & 1023 }, 2000),
    copy: per(() => { sink = (sink + pos.slice().length) & 1023 }, 20000),
    trieSet: per((i) => { rt = trieSet(rt, (i * 2654435761) & 4095, i) }, 200000),
    trieText: per(() => { sink = (sink + cursorWhole(trieFlat(rt)).length) & 1023 }, 2000),
  }
  const d = r.diff
  out({ item: 1, bench: 'fields-alone', commits: M, ns: r.ns, derived: { version: d('version', 'clear'), version_e3: d('version3', 'clear3'), version_e3_prefix: d('version3p', 'clear3'), bigint: d('bigint', 'clear'), cursor_one: d('cursor', 'clear'), cursor_one_e3: d('cursor3', 'clear3'), cursor_one_fast: d('cursorfast', 'clear'), cursor_prefix_version: d('cursorprefix', 'clear'), cursor_prefix_version_e3: d('cursorprefix3', 'clear3'), entry_version: d('entry', 'clear'), entry_version_e3: d('entry3', 'clear3'), diff_build: d('diffbuild', 'clear') }, whole, checks: { cursor_fast_vs_cursor_1e5: fastBad, version_prefix_vs_vtext_1e6: pBad, link_prefix_example: LINKPRE + vtext(0, 9001), lengths: { e0: vtext(0, 1e6).length, e3: vtext(3, 1e6).length } }, sink: sink >= 0 && flatSinkUsed() })
  process.exit(0)
}

// One resource and one tap for every way: a way only switches what the tap reads, and what the delivery hands the
// commit and keeps. So every way shares one heap, one selection and one link. (E-55's tap2 gives each way its own
// resource; here two copies of the same way then differed by a median of 50 to 90 ns, more than the bar.)
const depth = PART === 'part' ? 2 : 1
const f = fero('f', depth === 2 ? { depth: 2, data: { p: seedRows(N) } } : { data: seedRows(N) })
f.eng.promote()
let MODE = 0, calls = 0
const lens = depth === 2 ? f.data.p : f.data
lens.tap((c) => {
  if (c.first) return
  calls++
  switch (MODE) {
    case 0: break
    case 1: sink = (sink + c.version.length) & 1023; break
    case 2: sink = (sink + c.version.length + c.version.length) & 1023; break
    case 3: sink = (sink + vtextBig(c.ep, c.sq).length) & 1023; break
    case 4: sink = (sink + c.cursor.length) & 1023; break
    case 5: { const d = c.diff; for (let i = 0; i < d.length; i++) sink = (sink + d[i].key.length) & 1023; break }
    case 6: { const d = c.diff; for (let i = 0; i < d.length; i++) sink = (sink + d[i].key.length + d[i].version.length) & 1023; break }
    case 7: { const d = c.diff; for (let i = 0; i < d.length; i++) sink = (sink + d[i].version.length) & 1023; sink = (sink + c.version.length + c.cursor.length) & 1023; break }
    case 8: sink = (sink + c.versionP.length) & 1023; break
  }
})
const sel = depth === 2 ? f.eng.sels.get('p') : f.eng.all
const POS = new Float64Array(4096)
// what a link keeps (one shape for every way): the mode, the positions, the trie, the link's own cursor prefix (id and
// slot, made once per link) and the slot's epoch digits (made once per slot and epoch)
const LINKPRE = RID.toString('base64url') + '.' + RSLOT + '.', EPRE3 = eprefix(3)
const X = (mode) => ({ mode, pos: POS, root: T_EMPTY, pre: LINKPRE, epre: EPRE3 })
const XONE = X('one'), XPRE = X('prefix'), XPOS = X('pos'), XTEXT = X('text'), XCOPY = X('copy'), XTRIE = X('trie')
const go = depth === 2
  ? (r) => { for (let i = 0; i < W; i++) { H.slot = RSLOT; H.seq = (slotSeq[RSLOT] += gap[i & 4095]); f.set(['p', keys[i % N], 'n'], r * W + i + 1e9) } }
  : (r) => { for (let i = 0; i < W; i++) { const k = i % N, s = kslot[k]; H.slot = s; H.seq = (slotSeq[s] += gap[i & 4095]); f.set([keys[k], 'n'], r * W + i + 1e9) } }
// a way: what the link keeps, what the callback reads, and the slot's epoch the writer's header carries (0: the
// shortest version text; 3: a slot that has moved, been restored or recovered uncleanly)
const way = (hdr, mode, epoch = 0) => (r) => { sel.e62 = hdr; MODE = mode; H.epoch = epoch; go(r); return W }
const ways = PART === 'part' ? {
  'nothing, no header': way(null, 0),
  'nothing A': way(XONE, 0),
  'nothing B': way(XONE, 0),
  'c.version': way(XONE, 1),
  'c.version twice': way(XONE, 2),
  'c.version, BigInt form': way(XONE, 3),
  'c.cursor': way(XONE, 4),
  'c.diff': way(XONE, 5),
  'c.diff + version': way(XONE, 6),
  'all three': way(XONE, 7),
  'c.version, epoch 3': way(XONE, 1, 3),
  'c.version, epoch 3, its digits made once': way(XONE, 8, 3),
  'c.cursor, epoch 3': way(XONE, 4, 3),
  'c.cursor prefix': way(XPRE, 4),
  'c.cursor prefix, epoch 3': way(XPRE, 4, 3),
  'c.diff + version, epoch 3': way(XONE, 6, 3),
} : {
  'nothing, no header': way(null, 0),
  'nothing, positions A': way(XPOS, 0),
  'nothing, positions B': way(XPOS, 0),
  'c.cursor text': way(XTEXT, 4),
  'c.cursor copy': way(XCOPY, 4),
  'nothing, trie kept': way(XTRIE, 0),
  'c.cursor trie': way(XTRIE, 4),
}
const res = interleave(ways, { rounds: ROUNDS, ops: W })

// checks: the version text equals E-56's BigInt form; a whole cursor's text decodes to the positions kept
const ck = rng(62)
let vbad = 0
for (let i = 0; i < 1e6; i++) { const e = i % 4 === 0 ? Math.floor(ck() * 8) : 0, s = Math.floor(ck() * 2 ** (i % 2 ? 40 : 20)); if (vtext(e, s) !== vtextBig(e, s)) vbad++ }
let cursorCheck = 'n/a', cursorBytes = null, trieCheck = 'n/a'
if (PART === 'whole') {
  const x = XTEXT
  const t = cursorWhole(x.pos)
  cursorBytes = { bytes: Buffer.from(t, 'base64url').length, chars: t.length }
  const back = decodeWhole(t); let bad = 0; for (let i = 0; i < 4096; i++) if (back[i] !== x.pos[i]) bad++
  cursorCheck = bad === 0 ? 'ok' : 'MISMATCH ' + bad
  // the trie against a flat array, 100,000 seeded updates, and every kept root still holds its own place
  let root = T_EMPTY; const arr = new Float64Array(4096), roots = [], arrs = []; let b2 = 0
  for (let i = 0; i < 100000; i++) { const s = Math.floor(ck() * 4096), v = i + 1; root = trieSet(root, s, v); arr[s] = v; if (i % 10000 === 0) { roots.push(root); arrs.push(arr.slice()) } }
  const f2 = trieFlat(root); for (let i = 0; i < 4096; i++) if (f2[i] !== arr[i]) b2++
  roots.forEach((r, j) => { const g = trieFlat(r); for (let i = 0; i < 4096; i++) if (g[i] !== arrs[j][i]) b2++ })
  trieCheck = b2 === 0 ? 'ok' : 'MISMATCH ' + b2
} else {
  const t = cursor1(RSLOT, 0, slotSeq[RSLOT]), t2 = LINKPRE + vtext(0, slotSeq[RSLOT])
  cursorBytes = { bytes: Buffer.from(t, 'base64url').length, chars: t.length, example: t, prefix_form: t2, prefix_chars: t2.length, version_e0: vtext(0, slotSeq[RSLOT]), version_e3: vtext(3, slotSeq[RSLOT]) }
}
const d = res.diff
const derived = PART === 'part' ? {
  noise_B_minus_A: d('nothing B', 'nothing A'),
  header_over_noheader: d('nothing A', 'nothing, no header'),
  version_over_nothing: d('c.version', 'nothing A'),
  second_read: d('c.version twice', 'c.version'),
  bigint_over_nothing: d('c.version, BigInt form', 'nothing A'),
  cursor_over_nothing: d('c.cursor', 'nothing A'),
  diff_over_nothing: d('c.diff', 'nothing A'),
  diffversion_over_diff: d('c.diff + version', 'c.diff'),
  all_over_diff: d('all three', 'c.diff'),
  version_e3_over_nothing: d('c.version, epoch 3', 'nothing A'),
  version_e3_prefix_over_nothing: d('c.version, epoch 3, its digits made once', 'nothing A'),
  cursor_e3_over_nothing: d('c.cursor, epoch 3', 'nothing A'),
  cursor_prefix_over_nothing: d('c.cursor prefix', 'nothing A'),
  cursor_prefix_e3_over_nothing: d('c.cursor prefix, epoch 3', 'nothing A'),
  diffversion_e3_over_diff: d('c.diff + version, epoch 3', 'c.diff'),
} : {
  noise_B_minus_A: d('nothing, positions B', 'nothing, positions A'),
  positions_over_nothing: d('nothing, positions A', 'nothing, no header'),
  text_over_positions: d('c.cursor text', 'nothing, positions A'),
  copy_over_positions: d('c.cursor copy', 'nothing, positions A'),
  trie_over_nothing: d('nothing, trie kept', 'nothing, no header'),
  trieread_over_trie: d('c.cursor trie', 'nothing, trie kept'),
}
// the trie's text when saved, timed alone: flatten and encode one root (median of 200)
let trieText = null
if (PART === 'whole') {
  const root = XTRIE.root, xs = []
  for (let i = 0; i < 200; i++) { const t0 = process.hrtime.bigint(); sink += cursorWhole(trieFlat(root)).length; xs.push(Number(process.hrtime.bigint() - t0)) }
  xs.sort((a, b) => a - b); trieText = { ns_med: xs[100], ns_lo: xs[0], ns_hi: xs[199] }
}
out({ item: 1, bench: 'fields-' + PART, rows: N, writes: W, rounds: ROUNDS, ns: res.ns, calls, derived, checks: { version_text_vs_bigint_1e6: vbad, cursor: cursorCheck, trie: trieCheck }, cursorBytes, trieText, sink: sink >= 0 && flatSinkUsed() })
