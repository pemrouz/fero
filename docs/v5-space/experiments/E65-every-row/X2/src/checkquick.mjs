// E-65 X2: the quick run's verdict. Reads the JSON lines the quick run printed (stdin) and fails if the real
// code failed any seed, if a planted bug failed no seed (except 'oldpair', a rare case: 63 of 1,000 hard seeds),
// or if a timed scan's check did not hold.
import { readFileSync } from 'node:fs'
const lines = readFileSync(0, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
let bad = 0
for (const d of lines) {
  if (d.kind === 'sim') {
    const ok = d.bug === 'none' ? d.failed === 0 : d.bug === 'oldpair' || d.failed > 0
    if (!ok) { bad++; console.log('FAIL sim', d.mode, d.bug, 'failed', d.failed, 'of', d.seeds) }
  } else if (d.kind === 'scan' && !d.ok) { bad++; console.log('FAIL scan', d.name, d.note) }
}
const sims = lines.filter((d) => d.kind === 'sim'), scans = lines.filter((d) => d.kind === 'scan')
console.log(bad ? `quick: ${bad} failed` : `quick: ok (${sims.length} seeded runs, ${scans.length} timed scans, ${lines.length - sims.length - scans.length} other lines)`)
process.exit(bad ? 1 : 0)
