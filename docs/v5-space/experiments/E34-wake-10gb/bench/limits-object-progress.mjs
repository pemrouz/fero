// E-34 side probe, part 2: where a plain object used as a dictionary (data's adopted-object mode, $(obj))
// slows down. limits.mjs's `object` case never reached its 150 s cap check, so this one prints a line every
// 2^18 keys (count, seconds so far, seconds for that block, heap MB) and is stopped from outside
// (run.sh wraps it in `timeout`). The last line printed is how far it got.
//   node --max-old-space-size=8192 limits-object-progress.mjs
const STEP = 1 << 18
const o = {}
const t0 = performance.now()
let tb = t0
for (let n = 0; n < 20_000_000; n++) {
  o['k' + n] = n
  if (((n + 1) & (STEP - 1)) === 0) {
    const t = performance.now()
    console.log(JSON.stringify({ exp: 'E-34', part: 'limits-object-progress', keys: n + 1, seconds: +((t - t0) / 1e3).toFixed(2), block_s: +((t - tb) / 1e3).toFixed(2), heap_mb: Math.round(process.memoryUsage().heapUsed / 2 ** 20) }))
    tb = t
  }
}
console.log(JSON.stringify({ exp: 'E-34', part: 'limits-object-progress', done: true, keys: 20_000_000, seconds: +((performance.now() - t0) / 1e3).toFixed(2) }))
