// XB-4: the exact sum is exact over every finite double. Seeded random histories of adds and removes over a
// multiset, values drawn to hit the float limit (+-MAX, 1e308, 1.7e308), subnormals, -0, ordinary floats, and
// rarely NaN and the infinities. After every step the live sum must equal, as a value (Object.is), the exact
// rational sum of the multiset rounded once. The oracle shares no code with WideSum: it turns each double into
// an integer by doubling (exact for a non-integer double) and rounds through a decimal string (V8's strtod,
// correctly rounded). Planted: E-23's ExactSum as is (E23SUM=1).
//   node xb4-exactsum.mjs <seeds> <steps>
import { rng, WideSum, E23Sum, canon } from '../src/lib.mjs'

const SEEDS = +(process.argv[2] ?? 1000), STEPS = +(process.argv[3] ?? 1000)
const PLANT = process.env.E23SUM === '1'
const MAX = Number.MAX_VALUE
const FIVE = 5n ** 1074n

function oUnits(x) { // independent: x * 2^1074 as a BigInt, by doubling until an integer
  let k = 0, y = x
  while (!Number.isInteger(y)) { y *= 2; k++ }
  return BigInt(y) << BigInt(1074 - k)
}
function oRound(N) { // N * 2^-1074 = N * 5^1074 / 10^1074, written as a decimal and parsed (correctly rounded)
  if (N === 0n) return 0
  const neg = N < 0n
  const s = ((neg ? -N : N) * FIVE).toString(10)
  const str = s.length > 1074 ? s.slice(0, s.length - 1074) + '.' + s.slice(s.length - 1074) : '0.' + s.padStart(1074, '0')
  const v = Number(str)
  return neg ? -v : v
}
function oracle(ms) { // ms: array of values in the multiset
  let nan = 0, pinf = 0, ninf = 0, nf = 0, nz = 0, t = 0n
  for (const x of ms) {
    if (x !== x) nan++
    else if (x === Infinity) pinf++
    else if (x === -Infinity) ninf++
    else { nf++; if (Object.is(x, -0)) nz++; else if (x !== 0) t += oUnits(x) }
  }
  if (nan || (pinf && ninf)) return NaN
  if (pinf) return Infinity
  if (ninf) return -Infinity
  if (nf > 0 && nz === nf) return -0
  return oRound(t)
}
function gen(r) {
  const u = r()
  if (u < 0.25) return Math.floor(r() * 201) - 100
  if (u < 0.40) return Math.round(r() * 1e4) / 100
  if (u < 0.50) return (r() - 0.5) * 1e6
  if (u < 0.55) return (r() - 0.5) * 1e-3
  if (u < 0.70) return (r() < 0.5 ? -1 : 1) * [MAX, 1.7e308, 1e308, 8.98e307, MAX * (1 - r() * 1e-3)][Math.floor(r() * 5)]
  if (u < 0.78) return (r() < 0.5 ? -1 : 1) * 5e-324 * Math.floor(1 + r() * 2 ** 52) // subnormals
  if (u < 0.82) return (r() < 0.5 ? -1 : 1) * 2.2250738585072014e-308 * (1 + r()) // smallest normals
  if (u < 0.88) return -0
  if (u < 0.90) return 0
  if (u < 0.95) return (r() - 0.5) * 2 ** Math.floor(r() * 2040 - 1020) // any exponent
  if (u < 0.97) return NaN
  if (u < 0.985) return Infinity
  return -Infinity
}

let checks = 0, bad = 0, badSeeds = 0, overflows = 0, first = null
// the critic's eight edge histories first (CRITIC 1.3): [+x] adds, [-x] removes
const EDGE = [[1e308, 1e308, -1e308], [1e308, -1e308, 1e308], [1.7e308, 1.7e308, -1.7e308, 1], [MAX, MAX], [MAX, MAX, -MAX, -MAX], [-0], [-0, -0, '-' + 0], [0.1, 0.2, -0.1, -0.2]]
const edge = []
for (const h of EDGE) {
  const S = PLANT ? new E23Sum() : new WideSum()
  const ms = []
  for (const v of h) {
    if (v === '-0') { S.sub(-0); ms.splice(ms.findIndex((y) => Object.is(y, -0)), 1); continue }
    if (typeof v === 'string') continue
    if (v < 0 && ms.some((y) => y === -v) && h.indexOf(-v) < h.indexOf(v)) { S.sub(-v); ms.splice(ms.indexOf(-v), 1) } else { S.add(v); ms.push(v) }
  }
  const got = S.value(), want = oracle(ms)
  edge.push({ ok: Object.is(got, want), got: canon(got), want: canon(want) })
}
for (let seed = 1; seed <= SEEDS; seed++) {
  const r = rng(seed * 7919 + 13)
  const S = PLANT ? new E23Sum() : new WideSum()
  const ms = []
  let seedBad = 0
  for (let step = 0; step < STEPS; step++) {
    if (ms.length === 0 || (ms.length < 48 && r() < 0.55)) { const x = gen(r); ms.push(x); S.add(x) }
    else { const i = Math.floor(r() * ms.length); const x = ms[i]; ms[i] = ms[ms.length - 1]; ms.pop(); S.sub(x) }
    const got = S.value(), want = oracle(ms)
    checks++
    if (!Object.is(got, want)) { bad++; seedBad++; if (first === null) first = { seed, step, got: canon(got), want: canon(want), size: ms.length } }
  }
  overflows += S.overflows ?? 0
  if (seedBad) badSeeds++
}
console.log(JSON.stringify({ exp: 'E-57', part: 'b-merge', claim: 'XB-4', bench: 'exactsum-oracle', planted: PLANT ? 'E-23 ExactSum as is' : null, seeds: SEEDS, steps: STEPS, checks, mismatches: bad, seedsFailed: badSeeds, bigPathEntries: overflows, first, edgeCases: edge.length, edgeFailed: edge.filter((e) => !e.ok).length, edge }))
