// Probe 3 (I2): the callback's (state, commit).
//   node --expose-gc --experimental-strip-types commit.mjs identity      (a check: what state and commit are)
//   node --expose-gc --experimental-strip-types commit.mjs prev <K>      (timed, under the timing lock: K changes a commit)
// identity  for a row, a field, a partition (depth 2) and the whole resource: is each call's state a new object, is it
//           frozen, is it the same object as the call before; what a React-style setter (it skips a render when
//           Object.is(next, current)) does with it; what a state kept from an earlier call reads after more writes;
//           what the commit holds (first, changes with prev, seq, recs(), text(), a per-row version or not).
// prev      ns per commit over no link, one link on the whole resource, 10,000 rows, 100,000 commits a round of K field
//           writes each (spread over rows), the ways interleaved round by round, each in its own resource made up
//           front, the median of 9 rounds:
//             nothing   fn(state, commit) reads nothing
//             recs      fn reads commit.recs() only (the records: what code that forwards or stores wants)
//             changes   fn reads commit.changes and each change's prev (data's deltas, by reference)
//             diff      fn builds a fresh array of { op, key, row, prev, version } per commit (an eager diff object)
//             leafdiff  the same, with prev and now taken down to the written field (leafAt)
//             text      fn reads commit.text() (the records as JSON, once a commit)
//           then the same work alone (no writes in the timed loop): 100,000 commits' changes captured by reference from
//           a real fold, and each way run over them: ns per change (read prev, build a diff, build a field diff, build
//           the records, the records as JSON)
import { fero, leafAt, toRecs } from '../../../E55-lens-prototype/proto/lens.mjs'
import { seedRows, gc, now, med, r1 } from '../../../E55-lens-prototype/bench/common.mjs'
import '../proto/connect.mjs'

const out = (o) => console.log(JSON.stringify({ exp: 'E-56', probe: 3, node: process.version, ...o }))
const PART = process.argv[2]
const tick = () => new Promise((r) => setImmediate(r))

if (PART === 'identity') {
  const res = {}
  // a React-style setter: a render only when the value is not Object.is the current one (React's useState rule)
  const setter = () => { const s = { cur: undefined, renders: 0 }; s.set = (v) => { if (!Object.is(v, s.cur)) { s.cur = v; s.renders++ } }; return s }
  const probe = async (name, f, lens, write, W = 5) => {
    const seen = [], st = setter(), wrapped = setter()
    let firstKept, commitShape = null
    const h = lens.connect((state, c) => {
      seen.push({ state, c })
      st.set(state); wrapped.set({ rows: state })
      if (!c.first && commitShape === null) {
        const d = c.changes[0]
        commitShape = { commitFields: Object.keys(c).filter((k) => !k.startsWith('_')).concat(['changes', 'now', 'recs()', 'text()']), changeFields: Object.keys(d), aChangeHasVersion: 'version' in d, prevIsTheStateBefore: Object.is(d.prev, seen.at(-2)?.state) || Object.is(d.prev, seen.at(-2)?.state?.[d.key]), rowIsTheStateNow: Object.is(d.row, state) || Object.is(d.row, state?.[d.key]), aRecord: c.recs()[0], text: c.text() }
      }
    })
    await h.ready
    firstKept = JSON.stringify(h.state)
    const kept = seen[0].state
    for (let i = 0; i < W; i++) write(i)
    const sameAsBefore = seen.slice(1).map((x, i) => Object.is(x.state, seen[i].state))
    res[name] = {
      calls: seen.length,
      stateType: typeof seen[0].state === 'object' ? (Object.getPrototypeOf(seen[0].state) === null ? 'a null-prototype object (here: a Proxy over the live view)' : 'an object') : typeof seen[0].state,
      callsWhoseStateIsTheSameObjectAsTheCallBefore: sameAsBefore.filter(Boolean).length + ' of ' + sameAsBefore.length,
      frozen: seen.map((x) => typeof x.state === 'object' && x.state !== null ? Object.isFrozen(x.state) : 'n/a').filter((x) => x === true).length + ' of ' + seen.length,
      reactStyleSetterRenders: st.renders + ' of ' + seen.length + ' calls',
      setterWithANewWrapperEachCallRenders: wrapped.renders + ' of ' + seen.length,
      theFirstCallsStateReadAfterTheWrites: JSON.stringify(kept)?.slice(0, 80), itWasThen: firstKept.slice(0, 80),
      commit: commitShape,
    }
    h.disconnect()
  }
  const srv = fero('shop', { data: { k1: { n: 1, tags: ['a'] }, k2: { n: 2, tags: ['b'] } } })
  await probe('a row: shop.data.k1', srv, srv.data.k1, (i) => srv.data.k1.n.set(10 + i))
  await probe('a field: shop.data.k1.n', srv, srv.data.k1.n, (i) => srv.data.k1.n.set(20 + i))
  await probe('the whole resource: shop.data', srv, srv.data, (i) => srv.data.k2.n.set(30 + i))
  const chat = fero('chat', { depth: 2, data: { room1: { m1: { t: 'hi' }, m2: { t: 'yo' } } } })
  await probe('a partition (depth 2): chat.data.room1', chat, chat.data.room1, (i) => chat.set(['room1', 'm' + (3 + i)], { t: 'x' + i }))
  out({ part: 'identity', cases: res })
}

if (PART === 'prev') {
  const K = +(process.argv[3] ?? 1), ROWS = 10000, M = 100000, ROUNDS = 9
  let v = 0
  const ways = {}
  const mk = (fn) => {
    const s = fero('s', { data: seedRows(ROWS) }); s.eng.promote()
    if (fn) s.data.connect(fn)
    return (m) => {
      for (let j = 0; j < m; j++) {
        if (K === 1) s.set(['k' + ((j * 7919) % ROWS), 'n'], ++v)
        else s.eng.rt.batch(() => { for (let k = 0; k < K; k++) s.set(['k' + (((j * K + k) * 7919) % ROWS), 'n'], ++v) })
      }
    }
  }
  let sink = 0
  ways.none = mk(null)
  ways.nothing = mk(() => { sink++ })
  ways.recs = mk((st, c) => { sink += c.recs().length })
  ways.changes = mk((st, c) => { const ds = c.changes; for (let i = 0; i < ds.length; i++) if (ds[i].prev !== undefined) sink++ })
  ways.diff = mk((st, c) => { const ds = c.changes, o = new Array(ds.length); for (let i = 0; i < ds.length; i++) { const d = ds[i]; o[i] = { op: d.op, key: d.key, row: d.row, prev: d.prev, version: c.seq } } sink += o.length })
  ways.leafdiff = mk((st, c) => { const ds = c.changes, o = new Array(ds.length); for (let i = 0; i < ds.length; i++) { const d = ds[i]; o[i] = { op: d.op, key: d.key, path: d.path, now: d.path?.length ? leafAt(d.row, d.path) : d.row, prev: d.path?.length ? leafAt(d.prev, d.path) : d.prev, version: c.seq } } sink += o.length })
  ways.text = mk((st, c) => { sink += c.text().length })
  for (const w of Object.values(ways)) w(5000) // warm
  const names = Object.keys(ways)
  const xs = Object.fromEntries(names.map((k) => [k, []]))
  for (let r = 0; r < ROUNDS; r++) {
    const order = names.slice(r % names.length).concat(names.slice(0, r % names.length))
    for (const k of order) { gc(); const t0 = now(); ways[k](M); xs[k].push(Number(now() - t0) / M) }
  }
  const over = (a, b) => r1(med(xs[a].map((x, i) => x - xs[b][i])))
  // the same work alone, with no writes in the loop: 100,000 commits' changes captured by reference from a real fold,
  // then each way run over them; ns per change, the median of 9 interleaved rounds
  const cap = []
  { const s = fero('s', { data: seedRows(ROWS) }); s.eng.promote(); let seq = 0; s.data.connect((st, c) => { if (!c.first) cap.push({ ds: c.changes, seq: ++seq, prefix: null }) }); await tick(); for (let j = 0; j < M; j++) { if (K === 1) s.set(['k' + ((j * 7919) % ROWS), 'n'], ++v); else s.eng.rt.batch(() => { for (let k = 0; k < K; k++) s.set(['k' + (((j * K + k) * 7919) % ROWS), 'n'], ++v) }) } }
  const alone = {
    'read prev': () => { let n = 0; for (const c of cap) { const ds = c.ds; for (let i = 0; i < ds.length; i++) if (ds[i].prev !== undefined) n++ } return n },
    'build a diff': () => { let n = 0; for (const c of cap) { const ds = c.ds, o = new Array(ds.length); for (let i = 0; i < ds.length; i++) { const d = ds[i]; o[i] = { op: d.op, key: d.key, row: d.row, prev: d.prev, version: c.seq } } n += o.length } return n },
    'build a field diff': () => { let n = 0; for (const c of cap) { const ds = c.ds, o = new Array(ds.length); for (let i = 0; i < ds.length; i++) { const d = ds[i]; o[i] = { op: d.op, key: d.key, path: d.path, now: d.path?.length ? leafAt(d.row, d.path) : d.row, prev: d.path?.length ? leafAt(d.prev, d.path) : d.prev, version: c.seq } } n += o.length } return n },
    'build the records': () => { let n = 0; for (const c of cap) n += toRecs(c.ds, null).length; return n },
    'records as JSON': () => { let n = 0; for (const c of cap) n += JSON.stringify(toRecs(c.ds, null)).length; return n },
  }
  const an = Object.keys(alone), ax = Object.fromEntries(an.map((k) => [k, []]))
  const changes = cap.reduce((a, c) => a + c.ds.length, 0)
  for (let r = 0; r < ROUNDS; r++) { const order = an.slice(r % an.length).concat(an.slice(0, r % an.length)); for (const k of order) { gc(); const t0 = now(); sink += alone[k](); ax[k].push(Number(now() - t0) / changes) } }
  out({ part: 'prev', changesPerCommit: K, rows: ROWS, commitsPerRound: M, rounds: ROUNDS, nsPerCommit: Object.fromEntries(names.map((k) => [k, r1(med(xs[k]))])), overNone: Object.fromEntries(names.filter((k) => k !== 'none').map((k) => [k, over(k, 'none')])), overNothing: Object.fromEntries(['recs', 'changes', 'diff', 'leafdiff', 'text'].map((k) => [k, over(k, 'nothing')])), diffOverRecs: over('diff', 'recs'), aloneNsPerChange: Object.fromEntries(an.map((k) => [k, r1(med(ax[k]))])), capturedChanges: changes, sink: sink > 0 })
}
