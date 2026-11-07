// E-04's guard (TEST-10): feed the TS twin and the WASM twin of K the same seeded input streams
// and compare their effect bytes, step by step, and their final state dumps.
// node --experimental-strip-types bench/diff.ts <k.wasm> <seeds> [label]
// E04_TRAP=<name> plants a bug in the TS twin; a trap-built .wasm plants one in the Rust twin.
// Prints one JSON line: seeds, seeds that differ, the first one, and where it first differs.
import { tsKernel } from '../k-ts/k.ts'
import { compileK, wasmKernel } from '../sim/kwasm.ts'
import { runSeed } from '../sim/simk.ts'

const [wasmPath, seedsArg, label] = process.argv.slice(2)
const SEEDS = Number(seedsArg ?? 1000)
const TICKS = Number(process.env.TICKS ?? 130)
const T = tsKernel(), Wk = wasmKernel(compileK(wasmPath))
let differ = 0, first: any = null, events = 0, violations = 0, crashed = 0
const firstBySeed: number[] = []
for (let s = 1; s <= SEEDS; s++) {
  const ta: number[] = [], wa: number[] = []
  let rt, rw
  try { rt = runSeed(T, s, { hash: true, trace: ta, ticks: TICKS }) } catch (e) { rt = { err: String(e) } as any }
  try { rw = runSeed(Wk, s, { hash: true, trace: wa, ticks: TICKS }) } catch (e) { rw = { err: String(e) } as any }
  if ((rt as any).err || (rw as any).err) crashed++
  events += ta.length
  violations += (rt.violations?.length ?? 0) + (rw.violations?.length ?? 0)
  let at = -1
  const m = Math.min(ta.length, wa.length)
  for (let i = 0; i < m; i++) if (ta[i] !== wa[i]) { at = i; break }
  if (at < 0 && ta.length !== wa.length) at = m
  const dumpsSame = rt.dumps && rw.dumps && rt.dumps.length === rw.dumps.length && rt.dumps.every((d: Uint8Array, i: number) => Buffer.compare(Buffer.from(d), Buffer.from(rw.dumps[i])) === 0)
  if (at >= 0 || !dumpsSame || rt.hash !== rw.hash) {
    differ++
    firstBySeed.push(at)
    if (!first) first = { seed: s, step: at, ofSteps: ta.length, dumpsSame, tsErr: (rt as any).err, wasmErr: (rw as any).err }
  }
}
console.log(JSON.stringify({ label: label ?? 'clean', trap: process.env.E04_TRAP ?? '', wasm: wasmPath.split('/').pop(), seeds: SEEDS, ticks: TICKS, events, seedsDiffer: differ, first, medianFirstDiffStep: firstBySeed.length ? firstBySeed.sort((a, b) => a - b)[firstBySeed.length >> 1] : null, monitorViolations: violations, kernelErrors: crashed }))
