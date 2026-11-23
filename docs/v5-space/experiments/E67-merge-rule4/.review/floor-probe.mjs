// Review probe (skeptic, second pass). Makes probe-sim.mjs, a copy of ../sim/sim.mjs with:
//   --floor=exact|stale|mixed   where a rebuild's pictures start their halves. exact: the dead merger's place
//                               for each group (what sim.mjs does). stale: one older cut of the dead merger
//                               (one of its last 64 served cuts), the same for every group. mixed: each group
//                               its own older cut, as if each host kept only the last place acked to it.
//   kindsNoCase                 the first-failure kinds of failing seeds that had no rule-4 case with rows.
//   stalePics, staleHalves      rebuild pictures whose floor was lowered, and the extra halves they carried.
// At --floor=exact the copy behaves exactly as sim.mjs (it draws its extra randomness only at stale or mixed).
//   node floor-probe.mjs && node probe-sim.mjs --world=stress --fix=a --floor=mixed --seeds=1000
import { readFileSync, writeFileSync } from 'node:fs'
let s = readFileSync(new URL('../sim/sim.mjs', import.meta.url), 'utf8')
const rep = (a, b) => { if (s.split(a).length !== 2) throw new Error('not once: ' + a.slice(0, 60)); s = s.replace(a, b) }
rep("const SEEDS = +arg('seeds', '1000')", "const FLOOR = arg('floor', 'exact'); const SEEDS = +arg('seeds', '1000')")
rep("const ri = (a, b) =>", "const RP = rng(SEED * 101 + 7), snaps = [], floorOf = new Map()\n  const ri = (a, b) =>")
rep("    if (!intake.serving()) return\n    if (gapFrom >= 0) {", "    if (!intake.serving()) return\n    snaps.push(new Map([...intake.st].map(([g, x]) => [g, x.pos]))); if (snaps.length > 64) snaps.shift()\n    if (gapFrom >= 0) {")
rep("    for (const mv of intake.closed) oldClosed.add(mv)\n    intake.rebuild()",
  "    floorOf.clear()\n    if (FLOOR !== 'exact' && snaps.length) { const one = snaps[Math.floor(RP() * snaps.length)]; for (const g of groups.keys()) { const sn = FLOOR === 'stale' ? one : snaps[Math.floor(RP() * snaps.length)]; floorOf.set(g, Math.min(sn.get(g) ?? 0, intake.st.get(g).pos)) } }\n    for (const mv of intake.closed) oldClosed.add(mv)\n    intake.rebuild()")
rep("halves: carry ? halvesIn(g, s.pos, p) : []", "halves: carry ? halvesIn(g, rebuild && floorOf.has(g) ? floorOf.get(g) : s.pos, p) : []")
rep("const kinds = {}, after = {}, firsts = []", "const kinds = {}, after = {}, firsts = [], kindsNoCase = {}")
rep("kinds[kind] = (kinds[kind] ?? 0) + 1", "kinds[kind] = (kinds[kind] ?? 0) + 1; if (!st.cases) kindsNoCase[kind] = (kindsNoCase[kind] ?? 0) + 1")
rep("console.log(JSON.stringify({ world: WORLD,", "console.log(JSON.stringify({ floor: FLOOR, kindsNoCase, world: WORLD,")
rep("healthChecks: 0, casesAny: 0,", "healthChecks: 0, casesAny: 0, stalePics: 0, staleHalves: 0,")
rep("    const carry = CARRIES && !(rebuild && MUTATE === 'rebuildnol')", "    const carry = CARRIES && !(rebuild && MUTATE === 'rebuildnol')\n    if (rebuild && floorOf.has(g) && floorOf.get(g) < s.pos) { st.stalePics++; st.staleHalves += halvesIn(g, floorOf.get(g), s.pos).length }")
rep("'picWait', 'healthChecks']", "'picWait', 'healthChecks', 'stalePics', 'staleHalves']")
writeFileSync(new URL('./probe-sim.mjs', import.meta.url), s)
