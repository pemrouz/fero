// E-64 O2, claim T1: a top-k (za('score', k), ties by key) per share from the change stream with a bounded
// buffer and refills, and the top k of the shares' answers merged. One JSON line per run.
//   node sim-topk.mjs --groups=4 --shares=4 --k=10 --kp=20 --kmax=40 --steps=20000 [--seeds=N] [--mutate=...]
// Faults: a runner restart (1 in `restart` runner steps, default 4,000: a refill); moves as in D1. After every `check` steps and at
// the end, each share's answer is compared with the pure top k of the share's rows at the runner's cut, and
// the merged answer with the pure top k of every row at the combined cut.
import { World } from './world.mjs'
import { TopRunner, checkTop } from './topk.mjs'
import { rng, out } from './lib.mjs'

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d }
const G = +arg('groups', 4), S = +arg('shares', 4), K = +arg('k', 10), KP = +arg('kp', 20), KMAX = +arg('kmax', 40)
const STEPS = +arg('steps', 20000), SEED = +arg('seed', 1), SEEDS = +arg('seeds', 0), MUT = arg('mutate', '')
const CHECK = +arg('check', 50), KEYS = +arg('keys', 600), SLOTS = +arg('slots', 1024), dom = arg('dom', 'dirty'), RESTART = +arg('restart', 4000)

function runSeed(seed, steps) {
  const r = rng(seed * 104729 + 11)
  const world = new World({ seed, G, slots: SLOTS, keys: KEYS, dom })
  for (let i = 0; i < KEYS; i++) world.step() // some rows first, so the shares are not empty
  const runners = Array.from({ length: S }, (_, i) => new TopRunner({ world, share: i, S, k: K, kp: KP, kmax: KMAX, mutate: MUT, r }))
  const st = { checks: 0, bad: 0, mergedBad: 0 }
  const check = () => { const c = checkTop(world, runners, K); st.checks++; if (c.bad) st.bad++; if (c.mergedBad) st.mergedBad++; return c.bad + c.mergedBad }
  for (let t = 0; t < steps; t++) {
    world.step()
    for (const R of runners) { if (r() < 0.9) R.tick(); if (r() < 1 / RESTART) R.restart() }
    if (t % CHECK === CHECK - 1) check()
  }
  for (const R of runners) R.drain()
  const endBad = check()
  const tot = { items: 0, changes: 0, refills: 0, refillRows: 0, trims: 0, restarts: 0, maxBuf: 0 }
  for (const R of runners) for (const k in tot) tot[k] = k === 'maxBuf' ? Math.max(tot[k], R.st[k]) : tot[k] + R.st[k]
  return { seed, failed: st.bad > 0 || st.mergedBad > 0 || endBad > 0, ...st, endBad, ...tot, moves: world.st.moves, rows: world.truth.size }
}

const t0 = performance.now()
if (SEEDS > 0) {
  let failed = 0, first = null
  const sum = { checks: 0, items: 0, changes: 0, refills: 0, refillRows: 0, trims: 0, restarts: 0, moves: 0 }
  let maxBuf = 0
  for (let s = 1; s <= SEEDS; s++) {
    const res = runSeed(s, STEPS)
    if (res.failed) { failed++; first ??= s }
    for (const k in sum) sum[k] += res[k]
    maxBuf = Math.max(maxBuf, res.maxBuf)
  }
  out({ exp: 'E-64', opt: 'O2', claim: 'T1', mode: 'seeds', groups: G, shares: S, k: K, kp: KP, kmax: KMAX, steps: STEPS, seeds: SEEDS, mutate: MUT || null, seedsFailed: failed, firstFailed: first, ...sum, maxBuf, secs: +((performance.now() - t0) / 1000).toFixed(1) })
} else {
  const res = runSeed(SEED, STEPS)
  out({ exp: 'E-64', opt: 'O2', claim: 'T1', mode: 'long', groups: G, shares: S, k: K, kp: KP, kmax: KMAX, steps: STEPS, mutate: MUT || null, ...res, secs: +((performance.now() - t0) / 1000).toFixed(1) })
}
