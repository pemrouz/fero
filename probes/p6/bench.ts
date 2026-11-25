// The TypeScript marker's cost: one marked call against the bare block, a micro-bench.
// Run it alone on a quiet machine: node probes/p6/bench.ts
//
// Three shapes of a rule's body, each run bare and marked, in the middle of a small hot loop:
//   guard   a comparison that decides a branch
//   block   one assignment into an object
//   value   Math.max of two numbers
// The loop does N passes; the best of ROUNDS rounds is taken for each. The difference per call
// is what the marker costs when no rule is switched off.
import { rule, switchOff, switchAllOn } from './rule.ts'

const N = 20_000_000
const ROUNDS = 7
const state = { last: 0, floor: 3, seen: 0 }

function bare(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const x = i & 1023
    if (x < state.floor) continue
    state.seen = x
    acc += Math.max(x, state.last)
  }
  return acc
}

function marked(n: number): number {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const x = i & 1023
    if (rule('test.guard', () => x < state.floor, false)) continue
    rule('test.block', () => { state.seen = x })
    acc += rule('test.value', () => Math.max(x, state.last), x)
  }
  return acc
}

function best(f: (n: number) => number): { ns: number; sum: number } {
  let ms = Infinity, sum = 0
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    sum = f(N)
    ms = Math.min(ms, performance.now() - t0)
  }
  return { ns: (ms * 1e6) / N, sum }
}

// Warm both, and make the marker see a switched-off id once, so the engine cannot assume
// the switch is never used.
bare(100_000); marked(100_000)
switchOff('test.none'); marked(100_000); switchAllOn()

const a = best(bare), b = best(marked)
if (a.sum !== b.sum) throw new Error('the marked loop gives another sum')
const per = (b.ns - a.ns) / 3
console.log(`bare loop    ${a.ns.toFixed(2)} ns per pass`)
console.log(`marked loop  ${b.ns.toFixed(2)} ns per pass (three markers)`)
console.log(`one marker   ${per.toFixed(2)} ns more than the bare block`)

// The same with a rule switched off that is not in the loop: the marker now compares ids.
switchOff('test.other')
const c = best(marked)
switchAllOn()
console.log(`a test run, another rule off: ${c.ns.toFixed(2)} ns per pass, ${((c.ns - a.ns) / 3).toFixed(2)} ns per marker`)
console.log(`ok bench: node ${process.version}`)
