// check — the harness every pattern check uses. A check is a body run once per seed in a fresh
// world, with a seeded fault schedule (leader changes that may lose an uncommitted tail, and one
// slot move) unless the check turns it off. After the body, the monitors run: no divergence between
// what the writer judged and what data folded, every caught-up replica equal to a fresh fold of the
// committed log, and no user-code fault unless the check expects one. A failing seed prints its
// fault schedule and the one command that replays it exactly.
//
//   node checks/<name>.check.ts                 every seed in the check's default range
//   node checks/<name>.check.ts --seeds 100     seeds 1..100
//   node checks/<name>.check.ts --seed 17       one seed (add --trace to print every event)
//   node checks/<name>.check.ts --no-chaos      without the fault schedule

import { fileURLToPath } from 'node:url'
import { World, type WorldOpts, type FaultStep, type Proc } from './world.ts'
import { fero, internals } from './index.ts'

export interface Chaos { leaderChanges?: number; moves?: number; within?: number | string; res?: string; down?: number }
export interface CheckOpts {
  /** default seeds when no flag is given */
  seeds?: number
  /** the fault schedule; false = none. Default: 2 leader changes and 1 move within the first 50 ms */
  chaos?: Chaos | false
  world?: WorldOpts
  /** user code may throw while folding (a check of DATA-06): do not fail on faults */
  faultsOk?: boolean
}
export interface Ctx {
  readonly w: World
  readonly seed: number
  /** simulated processes, by name */
  procs(...ids: string[]): Proc[]
  /** apply the check's fault schedule now (the harness does not, so the body chooses when) */
  chaos(spec?: Chaos): readonly FaultStep[]
  /** deliver everything in flight */
  settle(): Promise<void>
  ok(cond: unknown, msg: string): void
  eq(a: unknown, b: unknown, msg: string): void
  /** a note printed with a failing seed */
  note(s: string): void
  readonly stack: ReturnType<typeof internals.stack>
}
export interface Stats { elections: number; lost: number; dedup: number; dedupTail: number; moves: number; movesDone: number; handovers: number }
export interface Result { name: string; seeds: number; failed: { seed: number; error: string; faults: string[]; notes: string[] }[]; ms: number; events: number; traces: Map<number, string>; stats: Stats }

class Fail extends Error {}

const argv = process.argv.slice(2)
const flag = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }

export const runOne = async (name: string, body: (c: Ctx) => Promise<void>, seed: number, opts: CheckOpts, trace = false): Promise<{ error: string | null; faults: string[]; notes: string[]; events: number; trace: string; log: string[] | null; stats: Stats }> => {
  const w = fero.world({ seed, ...opts.world, trace })
  const notes: string[] = []
  let chaosSpec: Chaos | false = argv.includes('--no-chaos') ? false : opts.chaos ?? { leaderChanges: 2, moves: 1, within: 50 }
  const ctx: Ctx = {
    w, seed,
    procs: (...ids) => ids.map((id) => w.proc(id)),
    chaos: (spec) => {
      const c = spec ?? chaosSpec
      if (c === false) return []
      chaosSpec = false
      return w.chaos(c)
    },
    settle: () => w.settle(),
    ok: (c, msg) => { if (!c) throw new Fail(msg) },
    eq: (a, b, msg) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Fail(`${msg}: ${x} != ${y}`) },
    note: (s) => notes.push(s),
    get stack() { return internals.stack(w) },
  }
  let error: string | null = null
  try {
    await body(ctx)
    await w.settle()
    const st = internals.stack(w)
    const div = [...st.l2.divergences, ...st.l3.divergences]
    if (div.length > 0) throw new Fail(`divergence: ${div[0]}`)
    const folds = st.l3.checkFolds()
    if (folds.length > 0) throw new Fail(`a replica differs from the fold of the committed log: ${folds[0]}`)
    if (!opts.faultsOk && st.l3.faults.length > 0) throw new Fail(`user code threw while folding: ${st.l3.faults[0].error}`)
  } catch (e) {
    error = e instanceof Fail ? e.message : `${(e as Error)?.stack ?? e}`
  }
  const st = internals.stack(w)
  const stats: Stats = {
    elections: st.k.stats.elections, lost: st.k.stats.lost, handovers: st.k.stats.handovers,
    dedup: st.l2.stats.dedup, dedupTail: st.l2.stats.dedupTail,
    moves: st.k.moves.length, movesDone: st.k.moves.filter((m) => m.done !== undefined).length,
  }
  const out = { error, faults: [...w.faultLog], notes, events: w.events, trace: w.trace.hex(), log: w.traceLog, stats }
  await w.close()
  return out
}

export const check = async (name: string, body: (c: Ctx) => Promise<void>, opts: CheckOpts = {}): Promise<Result> => {
  const one = flag('--seed')
  const n = Number(flag('--seeds') ?? opts.seeds ?? 20)
  const seeds = one !== undefined ? [Number(one)] : Array.from({ length: n }, (_, i) => i + 1)
  const trace = argv.includes('--trace')
  const res: Result = { name, seeds: seeds.length, failed: [], ms: 0, events: 0, traces: new Map(), stats: { elections: 0, lost: 0, dedup: 0, dedupTail: 0, moves: 0, movesDone: 0, handovers: 0 } }
  const t0 = performance.now()
  for (const seed of seeds) {
    const r = await runOne(name, body, seed, opts, trace)
    res.events += r.events
    res.traces.set(seed, r.trace)
    for (const k of Object.keys(res.stats) as (keyof Stats)[]) res.stats[k] += r.stats[k]
    if (r.log) console.log(r.log.join('\n'))
    if (r.error) res.failed.push({ seed, error: r.error, faults: r.faults, notes: r.notes })
  }
  res.ms = performance.now() - t0
  return res
}

/** print a result the way every check ends: `ok <name> (N seeds)` or the failures and exit 1 */
export const report = (r: Result, file: string): void => {
  const rel = fileURLToPath(file).split('/E22-api-prototype/')[1] ?? file
  for (const f of r.failed.slice(0, 5)) {
    console.log(`FAIL ${r.name} seed ${f.seed}: ${f.error}`)
    if (f.faults.length) console.log(`  faults: ${f.faults.join(' | ')}`)
    for (const n of f.notes) console.log(`  note: ${n}`)
    console.log(`  replay: node --experimental-strip-types --no-warnings ${rel} --seed ${f.seed} --trace`)
  }
  if (r.failed.length > 0) { console.log(`FAILED ${r.name}: ${r.failed.length} of ${r.seeds} seeds`); process.exitCode = 1; return }
  const x = r.stats
  console.log(`ok ${r.name} (${r.seeds} seeds, ${r.events} events, ${(r.ms / 1000).toFixed(2)} s; faults hit: ${x.elections} elections, ${x.lost} tail entries lost, ${x.movesDone}/${x.moves} moves done, ${x.dedup} retries answered by dedup (${x.dedupTail} from the tail))`)
}

/** true when this file is the one node was asked to run */
export const isMain = (url: string): boolean => process.argv[1] !== undefined && fileURLToPath(url) === process.argv[1]
