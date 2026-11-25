#!/usr/bin/env node
// Prints one line per seed: seed, events, trace hash. The same lines the native
// runner prints, so the two can be compared byte for byte.
//
//   node probes/p2/lines.mjs <the .wasm> <start> <count> fold|nofold
//
// With `fold`, data folds every committed batch and the fold check runs.
import { compile, loadData, open } from './sim.mjs'

const [wasm, startArg, countArg, mode] = process.argv.slice(2)
if (!wasm || !startArg || !countArg || !['fold', 'nofold'].includes(mode)) {
  console.error('usage: node probes/p2/lines.mjs <the .wasm> <start> <count> fold|nofold')
  process.exit(2)
}
const D = mode === 'fold' ? await loadData() : null
const sim = open(compile(wasm), D)
const start = Number(startArg), count = Number(countArg)
const out = []
for (let seed = start; seed < start + count; seed++) {
  const r = sim.runSeed(seed)
  out.push(`${seed} ${r.events} ${r.hash}`)
}
console.log(out.join('\n'))
console.error(JSON.stringify({ mode, seeds: count, ...sim.stats }))
