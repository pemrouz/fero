// Cross-check ExactSum against Python's math.fsum (an independent C
// implementation). Prints, per case, the numbers and our result; check.py
// recomputes with fsum and compares bit for bit. Also checks that adding and
// then removing values in shuffled orders gives the bits of a fresh sum.
import { ExactSum, rng } from './lib.ts'
const R = rng(7)
const gen = () => {
  const u = R()
  if (u < 0.4) return Math.round(R() * 1e4) / 100
  if (u < 0.7) return (R() - 0.5) * 1e6
  if (u < 0.9) return (R() - 0.5) * 1e-3
  return (R() - 0.5) * 1e15
}
const lines: string[] = []
let historyBad = 0
for (let c = 0; c < 2000; c++) {
  const n = 1 + Math.floor(R() * 60)
  const xs = Array.from({ length: n }, gen)
  const e = new ExactSum()
  for (const x of xs) e.add(x)
  lines.push(JSON.stringify({ xs: xs.map(String), got: String(e.value()) }))
  // history independence: add extra values and remove them again, in another order
  const extra = Array.from({ length: 30 }, gen)
  const h = new ExactSum()
  const all = [...xs, ...extra].sort(() => R() - 0.5)
  for (const x of all) h.add(x)
  for (const x of extra.sort(() => R() - 0.5)) h.sub(x)
  if (!Object.is(h.value(), e.value())) historyBad++
  // merge: split xs into 4 partials and merge
  const parts = [new ExactSum(), new ExactSum(), new ExactSum(), new ExactSum()]
  xs.forEach((x, i) => parts[i % 4].add(x))
  const m = new ExactSum()
  for (const p of parts) m.mergeFrom(p)
  if (!Object.is(m.value(), e.value())) historyBad++
}
console.log(`# history and merge: ${historyBad} mismatches in 4000 (2000 add-then-remove in shuffled orders, 2000 merges of 4 partials)`)
console.log(lines.join('\n'))
