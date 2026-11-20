// B3, XB-8, XB-9, XB-10: derive's view form. A target resource is kept equal to a bucket view of a source:
// v1 = by('user').sum('cents') (exact), v2 = by('user').length() (a rolling deploy halfway through each seed).
//
// Simulated in one process with a seeded scheduler:
//   source   one log of commits (insert, cents and user changes, removes); its log is cut now and then (only the
//            last 20 records kept), so a deriver starts from a snapshot of rows, never from history
//   target   three target groups; each keeps a fence: the highest lock token it has seen; a fenced write with a
//            lower token is refused (E-24's fence-tokens), a higher one raises it
//   lock     the row derive:<target>: { holder, token, version }; a lease: a holder dead or paused for 12 steps
//            loses it; the next deriver takes it with token + 1
//   derivers two or three processes; each holds one data store of the source (rows from a snapshot, possibly
//            behind) with the view on it (src/ops.mjs ByView), and an outbox of fenced writes. A paused deriver
//            keeps its outbox and, when it wakes, still thinks it holds the lock; a refused write tells it that
//            it lost the lock. The network delivers outbox writes at its own pace.
//   on takeover (the full design): bump (XB-8: one fenced no-op per target group, all acknowledged), then the
//            read barrier (XB-9: read the source's commit position, after the bump, and fold to it), then read
//            the target's rows and write the difference (sets for changed buckets, removes for vanished ones),
//            then follow: one fenced write per changed bucket per source commit. The lock row carries the
//            deriver's code version, and a deriver never takes over from a newer version (XB-10).
// The oracle: at every idle point (the holder awake, following, at the source's head, its outbox empty) the
// target's rows equal the holder's view query run from scratch over the source's rows at the holder's cut.
// Also counted: stale writes accepted (a writer whose token is below the lock's) after the new holder's bump
// reached that group, and before it (reported); step-backs (an accepted write from a cut below the highest cut
// any accepted write came from) and whether each came at a deriver change; v1 output accepted after v2's.
// Configurations: PLAN=1 is the plan as written (fence, removes; no bump, no barrier, no version).
// Planted (MUTATE, against the full design): nofence, noremove, nobump, nobarrier, noversion.
//   node b3-derive.mjs <seeds> <steps>
import { rng, canon, num, bkey, applyRec, E23Sum } from '../src/lib.mjs'
import { D, laneOf, ByView } from '../src/ops.mjs'

const SEEDS = +(process.argv[2] ?? 1000), STEPS = +(process.argv[3] ?? 600)
const MUTATE = process.env.MUTATE ?? '', PLAN = process.env.PLAN === '1'
const FENCE = MUTATE !== 'nofence', REMOVES = MUTATE !== 'noremove'
const BUMP = !PLAN && MUTATE !== 'nobump', BARRIER = !PLAN && MUTATE !== 'nobarrier', VERSION = !PLAN && MUTATE !== 'noversion'
const TG = 3, LEASE = 12, KEEP = 20

const T = { seeds: 0, idleChecks: 0, unequal: 0, seedsUnequal: 0, staleAfterBump: 0, staleBeforeBump: 0, seedsStale: 0, stepBacks: 0, stepBacksAtChange: 0, stepBacksElsewhere: 0, seedsStepBack: 0, v1AfterV2: 0, seedsV1AfterV2: 0, changes: 0, minChanges: Infinity, takeovers: 0, emptyDiffTakeovers: 0, restartsAfterCut: 0, startsAfterCut: 0, sourceCommits: 0, targetWrites: 0, refused: 0, seedsFailed: 0, seedsFailedStaleExcused: 0 }
let first = null

function oView(rows, ver) { // the query from scratch: by(user) of sum(cents) (v1) or length (v2), typed keys, C5
  const m = new Map(), vals = new Map()
  for (const r of rows.values()) {
    const b = bkey(r.user)
    if (b === undefined) continue
    m.set(b, (m.get(b) ?? 0) + 1)
    let a = vals.get(b); if (!a) vals.set(b, (a = [])); const x = num(r.cents); if (x !== undefined) a.push(x)
  }
  if (ver === 2) return m
  const o = new Map()
  for (const [b, a] of vals) { const s = new E23Sum(); for (const x of a) s.add(x); o.set(b, s.value() === 0 ? 0 : s.value()) }
  return o
}
const groupOf = (b) => { let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b.charCodeAt(i)) | 0; return (h >>> 0) % TG }

function runSeed(seed) {
  const R = rng(seed * 97 + 5)
  // ── the source ──
  const log = [] // all records (the oracle's history; a deriver may read only the kept tail)
  let logStart = 0 // records before this index are cut
  const head = new Map()
  const users = Array.from({ length: 12 }, (_, i) => 'u' + i)
  const keys = Array.from({ length: 20 }, (_, i) => 'o' + i)
  function sourceCommit() {
    const k = keys[Math.floor(R() * keys.length)]
    const u = R()
    let rec
    if (!head.has(k)) rec = { type: 1, key: [], at: k, value: { user: users[Math.floor(R() * users.length)], cents: Math.floor(R() * 5) } }
    else if (u < 0.5) rec = { type: 0, key: [k, 'cents'], value: Math.floor(R() * 5) }
    else if (u < 0.7) rec = { type: 0, key: [k, 'user'], value: users[Math.floor(R() * users.length)] }
    else rec = { type: 2, key: [k] }
    log.push(rec); applyRec(head, rec)
    T.sourceCommits++
  }
  const rowsAt = (p) => { const m = new Map(); for (let i = 0; i < p; i++) applyRec(m, log[i]); return m }
  // ── the target ──
  const target = new Map() // bucket -> { value, ver, cut }
  const fence = new Array(TG).fill(0)
  let maxCut = -1, v2Seen = false
  // ── the lock ──
  const lock = { holder: null, token: 0, version: 0, since: 0 }
  // ── derivers ──
  let nextId = 0, deployed = false
  const ds = []
  let unequal = 0, stale = 0, stepBack = 0, stepBackElsewhere = 0, v1after = 0, changes = 0
  function spawn(step) {
    const rolling = deployed && step < (STEPS * 3) / 4 && R() < 0.4 // old code still restarts during the roll
    const d = { id: nextId++, ver: deployed && !rolling ? 2 : 1, alive: true, paused: 0, holder: false, token: 0, state: 'wait', out: [], pos: 0, src: null, view: null, bumpAcks: 0, barrier: 0, takeoverAt: -1, bumpDone: new Set(), lane: null }
    ds.push(d)
    return d
  }
  function startStore(d, step) { // a snapshot of the source rows, possibly behind the head (a lagging copy)
    const lag = Math.floor(R() * Math.min(15, log.length - logStart + 1))
    let p = Math.max(logStart, log.length - lag)
    if (logStart > 0) T.startsAfterCut++ // the log was cut before this start: the deriver reads rows, never history
    if (logStart > 0 && p === logStart) T.restartsAfterCut++
    const rows = rowsAt(p)
    d.src = D.$({}); d.lane = laneOf(d.src)
    const recs = [...rows].map(([k, r]) => ({ type: 1, key: [], at: k, value: r }))
    if (recs.length) d.lane(recs)
    d.pos = p
    d.view = new ByView(d.src, 'user', d.ver === 2 ? { agg: 'length' } : { agg: 'sum', of: 'cents', onCommit: null })
    d.view.onCommit = (chs) => { for (const c of chs) send(d, c.b, c.value) }
  }
  function send(d, b, value) { // a fenced write into the outbox
    if (d.state !== 'follow' && d.state !== 'diff') return // folding up to the barrier is silent: the diff covers it
    d.out.push({ kind: value === undefined ? 'remove' : 'set', b, value, token: d.token, ver: d.ver, cut: d.pos, from: d, holderAtSend: lock.token })
  }
  function deliver(w, step) {
    const g = w.kind === 'bump' ? w.g : groupOf(w.b)
    const d = w.from
    if (FENCE && w.token < fence[g]) { T.refused++; d.holder = false; d.state = 'wait'; d.out = []; return }
    if (w.token > fence[g]) fence[g] = w.token
    if (w.kind === 'bump') { d.bumpDone.add(g); return }
    const staleW = w.token < lock.token
    if (staleW) { // with a bump, a stale write that lands before the new holder's bump at g is read by its diff
      const cur = ds.find((x) => x.holder && x.token === lock.token)
      if (cur && cur.bumpDone.has(g)) { T.staleAfterBump++; stale++ } else { T.staleBeforeBump++; if (!BUMP) stale++ }
    }
    if (w.kind === 'remove') target.delete(w.b); else target.set(w.b, { value: w.value, ver: w.ver, cut: w.cut })
    T.targetWrites++
    if (w.cut < maxCut && !d.steppedBack) { // one step-back episode per deriver: its first write from below
      d.steppedBack = true
      T.stepBacks++; stepBack++
      if (d === lock.holder && d.token === lock.token) T.stepBacksAtChange++; else { T.stepBacksElsewhere++; stepBackElsewhere++ }
    }
    if (w.cut > maxCut) maxCut = w.cut
    if (w.ver === 2) v2Seen = true
    else if (v2Seen) { T.v1AfterV2++; v1after++ }
  }
  function tryAcquire(d, step) {
    if (!d.alive || d.paused || d.holder) return
    const h = lock.holder
    const expired = h === null || !h.alive || (h.paused && step - h.pausedAt >= LEASE)
    if (!expired) return
    if (VERSION && lock.version > d.ver) return // never take over from newer code
    lock.holder = d; lock.token++; lock.version = d.ver; lock.since = step
    d.holder = true; d.token = lock.token; d.out = []; d.bumpDone = new Set()
    d.takeoverAt = step
    changes++; T.takeovers++
    startStore(d, step)
    if (BUMP) { d.state = 'bump'; for (let g = 0; g < TG; g++) d.out.push({ kind: 'bump', g, token: d.token, from: d }) }
    else d.state = 'barrier0'
  }
  function fold(d) { // one source record into the deriver's store (only the kept tail can be read)
    if (d.pos < logStart) { // the log was cut past this deriver: it starts again from a snapshot, then re-diffs
      startStore(d, 0)
      d.state = 'barrier0' // the same barrier as a takeover, then the difference
      return
    }
    const rec = log[d.pos]
    d.pos++
    d.lane([rec])
  }
  function progress(d, step) {
    if (!d.alive || d.paused || !d.holder) return
    if (d.state === 'bump') { if (d.bumpDone.size === TG) d.state = 'barrier0'; return }
    if (d.state === 'barrier0') { d.barrier = BARRIER ? log.length : 0; d.state = 'barrier'; return }
    if (d.state === 'barrier') { if (d.pos < d.barrier) { fold(d); return } d.state = 'diff' }
    if (d.state === 'diff') { // read the target, write the difference
      const want = d.view.snapshot()
      let n = 0
      for (const [b, v] of want) { const t = target.get(b); if (t === undefined || !Object.is(t.value, v) || t.ver !== d.ver) { send(d, b, v); d.out[d.out.length - 1].takeover = true; n++ } }
      if (REMOVES) for (const b of target.keys()) if (!want.has(b)) { send(d, b, undefined); d.out[d.out.length - 1].takeover = true; n++ }
      if (n === 0) T.emptyDiffTakeovers++
      d.state = 'follow'
      return
    }
    if (d.state === 'follow' && d.pos < log.length) fold(d)
  }
  spawn(0); spawn(0)
  for (let step = 0; step < STEPS; step++) {
    if (!deployed && step >= STEPS / 2) deployed = true
    const u = R()
    if (u < 0.25) sourceCommit()
    else if (u < 0.6) { const h = ds.filter((d) => d.alive && !d.paused && d.holder); for (const d of h) for (let i = 0; i < 3; i++) progress(d, step) }
    else if (u < 0.95) { // the network delivers up to two writes of derivers that are awake
      for (let i = 0; i < 2; i++) { const xs = ds.filter((d) => d.alive && !d.paused && d.out.length > 0); if (xs.length) { const d = xs[Math.floor(R() * xs.length)]; deliver(d.out.shift(), step) } }
    } else if (u < 0.965) { const h = lock.holder; if (h && h.alive && !h.paused) { h.paused = 1; h.pausedAt = step; h.wakeAt = step + 8 + Math.floor(R() * 30) } }
    else if (u < 0.975) { const h = lock.holder; if (h && h.alive) { h.alive = false; h.holder = false } }
    else if (u < 0.985) { logStart = Math.max(logStart, log.length - KEEP) }
    for (const d of ds) if (d.paused && step >= d.wakeAt) d.paused = 0
    for (const d of ds) tryAcquire(d, step)
    const live = ds.filter((d) => d.alive)
    if (live.length < 2 || (deployed && live.every((d) => d.ver === 1))) spawn(step)
    if (deployed && step >= (STEPS * 3) / 4 && R() < 0.02) { const old = ds.filter((d) => d.alive && d.ver === 1 && !d.holder); if (old.length) old[0].alive = false } // the rolling deploy retires v1 slowly
    // an idle point: the holder awake, following, at the head, its outbox empty
    const h = lock.holder
    if (h && h.alive && !h.paused && h.holder && h.state === 'follow' && h.pos === log.length && h.out.length === 0) {
      T.idleChecks++
      const want = oView(rowsAt(h.pos), h.ver)
      let ok = want.size === target.size
      for (const [b, v] of want) { const t = target.get(b); if (t === undefined || !Object.is(t.value, v)) ok = false }
      if (!ok) { unequal++; T.unequal++; if (first === null) first = `seed ${seed} step ${step}: target ${canon([...target].map(([b, t]) => [b, t.value]))} vs view v${h.ver} ${canon(want)}` }
    }
  }
  T.seeds++
  T.changes += changes
  T.minChanges = Math.min(T.minChanges, changes)
  if (unequal) T.seedsUnequal++
  if (stale) T.seedsStale++
  if (stepBack) T.seedsStepBack++
  if (v1after) T.seedsV1AfterV2++
  // a seed fails on: unequal at an idle point, a stale write accepted, v1 after v2, or a step-back the design
  // forbids (the full design: any; the plan as written: one away from a deriver change)
  if (unequal || stale || v1after || (PLAN ? stepBackElsewhere : stepBack)) T.seedsFailed++
  // the same bar for both (added after the skeptic's F6): a stale write counts only through the harm it leaves
  // (unequal at idle), as the full design's restated XB-8 bar excuses one that lands before the bump
  if (unequal || v1after || (PLAN ? stepBackElsewhere : stepBack)) T.seedsFailedStaleExcused++
}

const t0 = performance.now()
for (let s = 1; s <= SEEDS; s++) runSeed(s)
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'B3+XB-8,9,10', bench: 'derive-view-form', config: PLAN ? 'plan as written (fence, removes)' : 'full (fence, removes, bump, barrier, version)', planted: MUTATE || null, seeds: SEEDS, steps: STEPS, ...T, writesPerSourceCommit: Math.round((T.targetWrites / T.sourceCommits) * 1000) / 1000, seconds: Math.round(performance.now() - t0) / 1000, first }))
