// E-64 O2, claim D1: count-by and sum-by from the change stream with before-images, exactly once, with no
// process holding the resource's rows. One JSON line per run.
//   node sim-delta.mjs --groups=4 --shares=4 --P=1|8 --dom=dirty --steps=20000 --seed=1 [--seeds=N] [--mutate=...]
// Each step: one source write (a move 1 in moveEvery), each runner reads 0 to 2 items from a random group and
// may flush its window, writes reach the target in order per runner, with a random lag. Faults, by the seed:
// a runner crash (1 in 400 runner steps: memory lost, outbox tail lost, part of it delivered later as a
// zombie), a re-delivery (1 in 300: a group's stream read again from up to 50 items back).
// After every `check` steps, and at the end after a drain, each output partition is compared with the pure
// query over the true rows at that partition's cut (its marks). A seed fails on any mismatch, or if the end
// state is not at the head.
import { World } from './world.mjs'
import { Target, Runner, checkTarget, crossAnomalies, TargetB, RunnerB, checkTargetB } from './delta.mjs'
import { rng, pureSumBy, out } from './lib.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d }
const G = +arg('groups', 4), S = +arg('shares', 4), P = +arg('P', 1), dom = arg('dom', 'dirty')
const STEPS = +arg('steps', 20000), SEED = +arg('seed', 1), SEEDS = +arg('seeds', 0), MUT = arg('mutate', '')
const CHECK = +arg('check', 50), KEYS = +arg('keys', 600), SLOTS = +arg('slots', 1024), W = +arg('W', 16)
const BUCKETS = +arg('buckets', 20), MOVE = +arg('moveEvery', 200), LAG = +arg('lag', 0.25)
const FORM = arg('form', 'marks'), DOWN = arg('down', '0') === '1' // form: marks (A) | replace (B); down: group 0 out for the middle half
const pure = (rows, keep) => pureSumBy(rows, 'user', 'cents', keep)

function runSeed(seed, steps) {
  const r = rng(seed * 104729 + 7)
  const world = new World({ seed, G, slots: SLOTS, keys: KEYS, dom, buckets: BUCKETS, moveEvery: MOVE })
  const B = FORM === 'replace'
  const target = B ? new TargetB({ S, mutate: MUT }) : new Target({ P, mutate: MUT })
  const runners = Array.from({ length: S }, (_, i) => B ? new RunnerB({ world, share: i, S, target, W, mutate: MUT, r }) : new Runner({ world, share: i, S, target, W, mutate: MUT, r }))
  let zombies = []
  const st = { checks: 0, bad: 0, cutsDiffer: 0, anomalies: 0, anomalyChecks: 0, crashes: 0, zombiesSent: 0, zombiesApplied: 0, gapsRestarts: 0, maxLag: 0 }
  const deliver = (n) => {
    for (let i = 0; i < n; i++) {
      if (zombies.length && r() < 0.2) { const w = zombies.shift(); st.zombiesSent++; if (target.apply(w) === 'ok') st.zombiesApplied++; continue }
      const R = runners[Math.floor(r() * S)]
      if (!R.outbox.length) continue
      const w = R.outbox.shift()
      const res = target.apply(w)
      if (B) { if (res === 'gap' || (res === 'fenced' && w.token === R.token)) { R.outbox = []; R.start(); st.gapsRestarts++ } continue }
      if (res === 'gap' || (res === 'dup' && w.inc === R.inc && MUT !== 'nomark')) { R.outbox = []; R.start(); st.gapsRestarts++ } // refused: start again from the marks
    }
  }
  const check = () => {
    if (B) { const c = checkTargetB(world, target, S, (rows) => pure(rows)); st.checks++; st.bad += (c.bad || c.mergedBad) ? 1 : 0; return c.bad + c.mergedBad }
    const c = checkTarget(world, target, S, pure)
    st.checks++; st.bad += c.bad ? 1 : 0; st.cutsDiffer += c.cutsDiffer
    if (P > 1 && st.checks % 10 === 0) { st.anomalies += crossAnomalies(world, target, c.cuts); st.anomalyChecks++ }
    return c.bad
  }
  let downWrites = 0, downProgress = 0
  for (let t = 0; t < steps; t++) {
    world.down = DOWN && t >= steps / 4 && t < (3 * steps) / 4 ? 0 : -1
    const before = target.st.ok
    world.step()
    for (const R of runners) {
      if (r() < 0.9) R.tick()
      if (r() < 1 / 400) { zombies = zombies.concat(R.crash()); st.crashes++ }
      if (r() < 1 / 300) R.redeliver()
    }
    if (r() < LAG) deliver(1 + Math.floor(r() * 2 * S)) // writes reach the target late: outboxes fill, so crashes lose tails
    if (world.down === 0) downWrites += target.st.ok - before
    if (t % CHECK === CHECK - 1) check()
  }
  // drain: no more writes; every runner reads to the head, every write and zombie lands
  world.down = -1
  for (let round = 0; round < 50; round++) {
    for (const R of runners) R.drain()
    while (zombies.length || runners.some((R) => R.outbox.length)) deliver(64)
    const atHead = runners.every((R) => R.mySlots.every((s) => R.pos.get(s) === world.spos[s]))
    if (atHead && runners.every((R) => !R.outbox.length)) break
  }
  const bad = check()
  let head = true
  if (B) { for (let s = 0; s < SLOTS; s++) if ((target.shares[s % S].at.get(s) ?? 0) !== world.spos[s]) head = false }
  else for (let o = 0; o < P; o++) for (let s = 0; s < SLOTS; s++) if ((target.marksOf(o, s % S)?.get(s) ?? 0) !== world.spos[s]) head = false
  const copiesBad = world.checkCopies()
  const tot = { items: 0, changes: 0, windows: 0, writes: 0, restarts: 0, blocked: 0, redelivered: 0, scannedRows: 0, waits: 0 }
  for (const R of runners) for (const k in tot) tot[k] += R.st[k]
  for (const k in tot) if (Number.isNaN(tot[k])) tot[k] = 0
  return { seed, failed: st.bad > 0 || bad > 0 || !head || copiesBad > 0, endBad: bad, head, copiesBad, downWrites, ...st, ...tot, target: target.st, world: world.st }
}

const t0 = performance.now()
if (SEEDS > 0) {
  let failed = 0, checks = 0, moves = 0, crashes = 0, zombiesApplied = 0, anomalies = 0, anomalyChecks = 0, cutsDiffer = 0, writes = 0, deltas = 0, gap = 0, dup = 0, fenced = 0, downWrites = 0, scannedRows = 0, changes = 0, waits = 0, first = null
  for (let s = 1; s <= SEEDS; s++) {
    const res = runSeed(s, STEPS)
    if (res.failed) { failed++; first ??= s }
    checks += res.checks; moves += res.world.moves; crashes += res.crashes; zombiesApplied += res.zombiesApplied; anomalies += res.anomalies; cutsDiffer += res.cutsDiffer
    writes += res.writes; deltas += res.target.deltas; gap += res.target.gap; dup += res.target.dup ?? 0; fenced += res.target.fenced ?? 0
    anomalyChecks += res.anomalyChecks; downWrites += res.downWrites; scannedRows += res.scannedRows; changes += res.world.changes; waits += res.waits
  }
  out({ exp: 'E-64', opt: 'O2', claim: FORM === 'replace' ? 'D2' : 'D1', form: FORM, mode: 'seeds', groups: G, shares: S, P: FORM === 'replace' ? null : P, dom, down: DOWN, steps: STEPS, seeds: SEEDS, mutate: MUT || null, seedsFailed: failed, firstFailed: first, checks, moves, crashes, zombiesApplied, gapRefusals: gap, dupRefusals: dup, fencedRefusals: fenced, writes, deltas, sourceChanges: changes, cutsDifferChecks: cutsDiffer, crossAnomalies: anomalies, anomalyChecks, writesWhileDown: DOWN ? downWrites : null, restartWaits: waits, scannedRows, secs: +((performance.now() - t0) / 1000).toFixed(1) })
} else {
  const res = runSeed(SEED, STEPS)
  out({ exp: 'E-64', opt: 'O2', claim: FORM === 'replace' ? 'D2' : 'D1', form: FORM, mode: 'long', down: DOWN, groups: G, shares: S, P, dom, mutate: MUT || null, ...res, secs: +((performance.now() - t0) / 1000).toFixed(1) })
}
