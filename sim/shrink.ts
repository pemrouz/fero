//! ── sim/shrink — minimize a failing seeded trajectory to a minimal reproduction ──
// The plan's module table named this file from day 0 (plan-v3.md §4); M7 builds it
// (DESIGN-M7 §2). The contract that makes shrinking sound on a seeded sim:
//
//   Build = (subset: Step[] | null) => Built
//
// A Build closure makes ALL of its rng draws unconditionally — fault personalities,
// write plans, chaos windows — and then POSTS only the given subset (null = post
// everything). Posting a Step draws nothing, so removing one step cannot shift any
// other step's randomness. Determinism is self-enforcing (replan-to-burn): there is
// no mirrored rng bookkeeping to fall out of lockstep, and the P0 reproduce gate
// catches a violated build contract empirically (the baseline simply fails to
// re-fail and the caller keeps the unshrunk capture, saying so).
//
// The oracle is the FIRST failure's CLASS, not its detail: monitor NAME for
// violations (details embed shifting seqs/values — witness, not identity), a NAMED
// end-check otherwise, and a digit-normalized message for throws. Too-strict an
// oracle and shrinking never converges; too loose and it converges onto a DIFFERENT
// bug. The residual same-monitor-different-bug risk is answered with honesty, not
// machinery: the original and final details ride the artifact side by side.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Sim, type Violation } from './exec.ts'
import { cluster, formed, writesPlan } from './harness.ts'
import { converged, drained } from './monitors.ts'
import type { Rec } from '../kernel/env.ts'
import type { Node } from '../kernel/node.ts'
import { captureSim } from '../tools/debug/capture.ts' // no cycle: capture.ts imports only TYPES from here
import { decodeVal } from '../tools/debug/model.mjs'

//! Step: one external stimulus, fully literal — posting a Step draws no rng, ever.
export type Step =
  | { at: number; op: 'write'; uuid: string; recs: Rec[] }
  | { at: number; op: 'partition'; a: string; b: string }
  | { at: number; op: 'heal'; a: string; b: string }

//! FailClass: the shrink oracle's equivalence unit — what must stay the same for a candidate to count.
export type FailClass =
  | { monitor: string } //  first violation's monitor NAME (detail is witness, not identity)
  | { end: string }     //  named end-of-run check: 'never-formed' | 'never-quiesced' | 'diverged' | 'undrained' | custom
  | { threw: string }   //  crash message, digit-runs normalized to '#' (seqs/counts shift under shrinking)

export interface BuiltFault { a: string; b: string; delay: [number, number]; dupP: number }
//! Built: one constructed-and-posted trajectory, plus the build-time facts replay needs (draws, faults, params).
export interface Built {
  sim: Sim
  nodes: Node[]
  planned: Step[]
  draws: number       // rng draws consumed at BUILD time (replayShrunk burns exactly these)
  faults: BuiltFault[]
  params: { seed: number; nodes: number; writes: number }
}
export type Build = (subset: Step[] | null) => Built

//! Ends: the pluggable end-of-run failure chain (run.ts's chain is the default; scoped scenarios pass their own).
export type Ends = [name: string, check: (b: Built) => unknown][]
export const ENDS: Ends = [
  ['never-formed', (b) => !formed(b.nodes)],
  ['never-quiesced', (b) => !b.sim.quiesced],
  ['diverged', (b) => converged(b.sim)],  // converged() returns a STRING on divergence, null when clean
  ['undrained', (b) => drained(b.sim)],
]

//! normalize — crash signatures with digit-runs collapsed: 'seq 41 != 40' and 'seq 12 != 11' are the same bug.
export const normalize = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/\d+/g, '#')

//! classify — the first failure's class, in run.ts's precedence order: violations, then the end chain, else null (green).
export const classify = (b: Built, ends: Ends = ENDS): FailClass | null => {
  if (b.sim.violations.length) return { monitor: b.sim.violations[0].monitor }
  for (const [name, check] of ends) if (check(b)) return { end: name }
  return null
}

//! describe — the human line for a class (the artifact carries original AND final, side by side — honesty over machinery).
export const describe = (cls: FailClass, b: Built | null, ends: Ends = ENDS): string => {
  if ('threw' in cls) return `threw ${cls.threw}`
  if ('monitor' in cls) {
    const v = b?.sim.violations[0]
    return v ? `monitor: ${cls.monitor} — ${v.detail} (event ${v.event})` : `monitor: ${cls.monitor}`
  }
  const chain = ends.find(([n]) => n === cls.end)
  const r = chain && b ? chain[1](b) : null
  return typeof r === 'string' ? `${cls.end}: ${r}` : cls.end
}

//! minimize — greedy single-removal, reverse-index passes to fixpoint: 1-minimal (no single step can be
// removed and still fail). Pure and Sim-free so shrink.test.ts unit-tests it against a stub predicate.
export const minimize = <T>(items: T[], holds: (subset: T[]) => boolean): T[] => {
  let cur = items.slice()
  for (let changed = true; changed; ) {
    changed = false
    for (let i = cur.length - 1; i >= 0; i--) {
      const cand = cur.slice(0, i).concat(cur.slice(i + 1))
      if (holds(cand)) { cur = cand; changed = true }
    }
  }
  return cur
}

//! Shrunk: the result + everything the artifact needs — the frozen-at-the-violation sim, the minimal steps,
// the original-vs-final honesty pair, and a standalone-replayable repro block (the fix-verification loop).
export interface Shrunk {
  steps: Step[]
  removed: number
  runs: number
  capped: boolean
  cls: FailClass
  fail: string // the FINAL run's human line (compare against from.fail before trusting a shrink)
  from: { steps: number; events: number; violation: Violation | null; fail: string }
  repro: { seed: number; nodes: number; writes: number; draws: number; faults: BuiltFault[]; steps: Step[] }
  sim: Sim
  nodes: Node[]
  atViolation: boolean
}

//! runOne — build + run + classify one candidate; a throw anywhere becomes the threw class (never escapes).
const runOne = (
  build: Build,
  subset: Step[] | null,
  ends: Ends,
  ropts: { until?: number; maxEvents?: number; stopOnViolation?: boolean },
): { b: Built | null; cls: FailClass | null } => {
  let b: Built | null = null
  try {
    b = build(subset)
    b.sim.run(ropts)
    return { b, cls: classify(b, ends) }
  } catch (e) {
    return { b, cls: { threw: normalize(e) } }
  }
}

//! shrink — P0 reproduce gate → P1 horizon truncation → P2 greedy 1-minimal → final frozen-at-violation run.
// Every stage is validated by an actual re-run; every candidate is event-capped at max(4×baseline, 50k)
// so a removal that de-quiesces a trajectory costs a bounded run, not the 1M-event runaway default.
export const shrink = (
  build: Build,
  opts: {
    budget?: number                                    // candidate-run budget (default 2000); exhausted → best-so-far, capped: true
    same?: (a: FailClass, b: FailClass) => boolean     // class equivalence (default: deep-equal)
    ends?: Ends                                        // end-of-run chain (default: run.ts's)
    horizon?: number                                   // run-until horizon for scenarios that never quiesce
  } = {},
): Shrunk | null => {
  const budget = opts.budget ?? 2000
  const same = opts.same ?? ((a: FailClass, b: FailClass) => JSON.stringify(a) === JSON.stringify(b))
  const ends = opts.ends ?? ENDS
  const ro = (extra: { maxEvents?: number; stopOnViolation?: boolean } = {}) =>
    ({ ...(opts.horizon !== undefined ? { until: opts.horizon } : {}), ...extra })

  //! P0 — the reproduce gate: build(null) must fail at all, or there is nothing sound to shrink.
  const base = runOne(build, null, ends, ro())
  if (!base.cls || !base.b) return null
  const baseCls = base.cls
  const baseEvents = base.b.sim.events
  const cap = Math.max(4 * baseEvents, 50_000) // floor so a crash-at-0 baseline doesn't uncap candidates
  let steps = base.b.planned
  let runs = 0
  let capped = false

  const holds = (subset: Step[]): boolean => {
    if (runs >= budget) { capped = true; return false }
    runs++
    const r = runOne(build, subset, ends, ro({ maxEvents: cap }))
    return r.cls !== null && same(r.cls, baseCls)
  }

  //! P1 — horizon truncation (monitor classes only): steps scheduled past the violation instant are dead weight.
  if ('monitor' in baseCls) {
    runs++
    const stop = runOne(build, steps, ends, ro({ maxEvents: cap, stopOnViolation: true }))
    if (stop.b && stop.cls && same(stop.cls, baseCls)) {
      const cut = steps.filter((s) => s.at <= stop.b!.sim.now)
      if (cut.length < steps.length && holds(cut)) steps = cut
    }
  }

  //! P2 — greedy to 1-minimal under the run budget.
  steps = minimize(steps, holds)

  //! final — re-run the minimal subset frozen AT the violation; that sim is what gets captured
  // (the capture ends at the violating event, so the viewer opens there by construction).
  const fin = runOne(build, steps, ends, ro('monitor' in baseCls ? { maxEvents: cap, stopOnViolation: true } : { maxEvents: cap }))
  if (!fin.b || !fin.cls || !same(fin.cls, baseCls)) return null // the minimal set must still fail — else the shrink lied
  return {
    steps,
    removed: base.b.planned.length - steps.length,
    runs,
    capped,
    cls: fin.cls,
    fail: describe(fin.cls, fin.b, ends),
    from: { steps: base.b.planned.length, events: baseEvents, violation: base.b.sim.violations[0] ?? null, fail: describe(baseCls, base.b, ends) },
    repro: { ...base.b.params, draws: base.b.draws, faults: base.b.faults, steps },
    sim: fin.b.sim,
    nodes: fin.b.nodes,
    atViolation: 'monitor' in baseCls && fin.b.sim.violations.length > 0,
  }
}

//! post — deliver a Step list to a sim, in array order. Draws nothing (the whole point).
export const post = (sim: Sim, steps: Step[]) => {
  for (const s of steps)
    if (s.op === 'write') sim.post(s.uuid, { kind: 'write', recs: s.recs }, s.at)
    else if (s.op === 'partition') sim.at(s.at, () => sim.partition(s.a, s.b))
    else sim.at(s.at, () => sim.heal(s.a, s.b))
}

//! sweepBuild — run.ts's sweep scenario as a Build: byte-identical draw order to the pre-M7 inline code
// (fault pairs → write plan → odd-seed partition window), pinned by shrink.test.ts's golden and the frozen
// 1000-seed sweep count. BUILD CONTRACT (loud, per DESIGN-M7 §2): every draw below runs UNCONDITIONALLY —
// never make a draw depend on `subset`, or replan-to-burn breaks and only the P0 gate will catch it.
export const sweepBuild = (seed: number, nNodes = 3, nWrites = 40): Build => (subset) => {
  const sim = new Sim(seed)
  let draws = 0
  const draw = () => { draws++; return sim.rng() }
  const nodes = cluster(sim, nNodes)
  //! per-pair personalities drawn from the seed: uneven delays + up to 25% duplication (run.ts's loop, verbatim)
  const faults: BuiltFault[] = []
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const f: BuiltFault = { a: nodes[i].uuid, b: nodes[j].uuid, delay: [1, 1 + draw() * 25], dupP: draw() * 0.25 }
      faults.push(f)
      sim.fault(f.a, f.b, { delay: f.delay, dupP: f.dupP })
    }
  const planned: Step[] = writesPlan(draw, nodes.map((n) => n.uuid), nWrites)
  //! odd seeds add the partition/heal window mid-writes (run.ts's block, verbatim draw order: a, b…, cut, heal-delay)
  if (seed % 2) {
    const a = nodes[Math.floor(draw() * nodes.length)].uuid
    let b = a
    while (b === a) b = nodes[Math.floor(draw() * nodes.length)].uuid
    const cut = 20 + draw() * 150
    planned.push({ at: cut, op: 'partition', a, b })
    planned.push({ at: cut + 30 + draw() * 250, op: 'heal', a, b })
  }
  post(sim, subset ?? planned)
  return { sim, nodes, planned, draws, faults, params: { seed, nodes: nNodes, writes: nWrites } }
}

//! replayShrunk — rebuild a shrunk repro from DATA alone: same seed, burn the recorded build-time draws,
// install the recorded faults, post the recorded steps. Run-time rng consumption then matches the shrink's
// final run frame for frame (posting draws nothing; delivery-time draws follow the same schedule).
export const replayShrunk = (repro: Shrunk['repro']): Built => {
  const sim = new Sim(repro.seed)
  const nodes = cluster(sim, repro.nodes)
  for (let i = 0; i < repro.draws; i++) sim.rng()
  for (const f of repro.faults) sim.fault(f.a, f.b, { delay: f.delay, dupP: f.dupP })
  post(sim, repro.steps)
  return { sim, nodes, planned: repro.steps, draws: repro.draws, faults: repro.faults, params: { seed: repro.seed, nodes: repro.nodes, writes: repro.writes } }
}

//! decodeSteps — undo capture.ts's encodeSteps after a JSON round-trip (values back through decodeVal).
export const decodeSteps = (steps: Step[]): Step[] =>
  steps.map((s) => (s.op === 'write' ? { ...s, recs: s.recs.map((r) => ('value' in r ? { ...r, value: decodeVal(r.value) } : r)) } : s))

//! ── CLI — `npm run shrink -- --seed N [--nodes 3] [--writes 40]` shrinks one sweep seed;
// `npm run shrink -- --replay captures/seed-N.shrunk.json` re-runs a shrunk artifact from DATA alone
// (the fix-verification loop: fix lands → replay the minimal repro → green). Exit 1 = still failing.

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] ?? '').href } catch { return false } })()
if (isMain) {
  const arg = (name: string, dflt: number): number => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? Number(process.argv[i + 1]) : dflt
  }
  const ri = process.argv.indexOf('--replay')
  if (ri >= 0) {
    const path = process.argv[ri + 1]
    const cap = JSON.parse(readFileSync(path, 'utf8'))
    if (!cap.shrunk?.repro) { console.error(`${path}: no shrunk.repro block — not a shrunk capture`); process.exit(2) }
    const b = replayShrunk({ ...cap.shrunk.repro, steps: decodeSteps(cap.shrunk.repro.steps) })
    let cls: FailClass | null
    try { b.sim.run(); cls = classify(b) } catch (e) { cls = { threw: normalize(e) } }
    if (cls) { console.log(`reproduced: ${describe(cls, b)}`); process.exit(1) }
    console.log('did NOT reproduce — the failure is fixed (or the repro block is stale)')
  } else {
    const seed = arg('seed', -1)
    if (seed < 0) { console.error('usage: npm run shrink -- --seed N [--nodes 3] [--writes 40] | --replay <capture.shrunk.json>'); process.exit(2) }
    const s = shrink(sweepBuild(seed, arg('nodes', 3), arg('writes', 40)))
    if (!s) { console.error(`seed ${seed}: green (or unreproducible) — nothing to shrink`); process.exit(1) }
    mkdirSync('captures', { recursive: true })
    const path = `captures/seed-${seed}.shrunk.json`
    writeFileSync(path, JSON.stringify(captureSim(s.sim, s)))
    console.log(`shrunk ${s.from.steps}→${s.steps.length} steps (${s.runs} runs${s.capped ? ', budget-capped' : ''}) → npm run debug -- ${path}`)
    console.log(`  original: ${s.from.fail}`)
    console.log(`  minimal:  ${s.fail}`)
  }
}
