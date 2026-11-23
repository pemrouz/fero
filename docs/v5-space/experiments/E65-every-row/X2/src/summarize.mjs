// E-65 X2: results/summary.md from results/sim.jsonl and results/bench.jsonl.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const R = new URL('../results/', import.meta.url)
const read = (f) => (existsSync(new URL(f, R)) ? readFileSync(new URL(f, R), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const sim = read('sim.jsonl'), bench = read('bench.jsonl')
const L = []
const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : x)
const range = (xs, d = 0) => { if (!xs.length) return '-'; const a = Math.min(...xs), b = Math.max(...xs); const f = (v) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }); return a === b ? f(a) : `${f(a)} to ${f(b)}` }

L.push('# E-65 X2: results in short', '', 'Printed by `src/summarize.mjs` from `sim.jsonl` and `bench.jsonl`. Ranges are over the three timed runs.', '')
L.push('## Seeded runs: the real code', '', '| world | mode | seeds | failed | checks | slot moves | copy failures | re-pins | torn commits / multi-slot commits seen | peak saved images | seconds |', '|---|---|---|---|---|---|---|---|---|---|---|')
for (const d of sim.filter((d) => d.bug === 'none')) L.push(`| ${d.tag} | ${d.mode} | ${fmt(d.seeds)} | ${d.failed} | ${fmt(d.checks)} | ${fmt(d.moves)} | ${fmt(d.fails)} | ${d.mode === 'cut' ? fmt(d.repins) : '-'} | ${d.mode === 'none' ? '-' : `${fmt(d.tornCommits)} / ${fmt(d.multiSlotCommitsSeen)}`} | ${d.mode === 'none' ? '-' : fmt(d.maxImages)} | ${d.sec} |`)
L.push('', '## Seeded runs: planted bugs (failed seeds of those run)', '', '| mode | bug | world | seeds | failed | first failure |', '|---|---|---|---|---|---|')
for (const d of sim.filter((d) => d.bug !== 'none')) L.push(`| ${d.mode} | ${d.bug} | ${d.tag} | ${fmt(d.seeds)} | ${fmt(d.failed)} | ${(d.firstBad[0] ?? []).slice(1, 3).join(' ')} |`)

const scans = bench.filter((d) => d.kind === 'scan')
const by = (xs, key) => { const m = new Map(); for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }
L.push('', '## The scan, timed (rows looked at per second; CPU per row; memory)', '', '| rows | scan | runs | seconds | rows/s | asking process ns/row (CPU) | servers ns/row (CPU, all four) | asking heap at peak MB (before) | MB received | checks ok | load at start |', '|---|---|---|---|---|---|---|---|---|---|---|')
for (const [k, xs] of by(scans, (d) => `${d.rows}|${d.name}`)) {
  const [rows, name] = k.split('|')
  L.push(`| ${fmt(+rows)} | ${name} | ${xs.length} | ${range(xs.map((x) => x.sec), 2)} | ${range(xs.map((x) => x.rowsPerSec))} | ${range(xs.map((x) => x.askerNsPerRow))} | ${range(xs.map((x) => x.serverNsPerRow))} | ${range(xs.map((x) => x.peakHeapMB), 1)} (${range(xs.map((x) => x.baseHeapMB), 1)}) | ${range(xs.map((x) => x.MBrecv), 1)} | ${xs.every((x) => x.ok) ? 'yes' : 'NO'} | ${range(xs.map((x) => x.load0), 2)} |`)
}
const w = scans.filter((d) => d.writesPerSecPerGroup)
if (w.length) {
  L.push('', '## Writes during the scan', '', '| rows | scan | writes/s a group | runs | seconds | writes during the scan | peak images kept (all groups) | note |', '|---|---|---|---|---|---|---|---|')
  for (const [k, xs] of by(w, (d) => `${d.rows}|${d.name}`)) { const [rows, name] = k.split('|'); L.push(`| ${fmt(+rows)} | ${name} | ${fmt(xs[0].writesPerSecPerGroup)} | ${xs.length} | ${range(xs.map((x) => x.sec), 2)} | ${range(xs.map((x) => x.serverWrote))} | ${range(xs.map((x) => x.serverPeakImages))} | ${xs[0].note} |`) }
}
const setup = bench.filter((d) => d.kind === 'setup')
if (setup.length) L.push('', `Setup: ${[...new Set(setup.map((s) => s.rows))].map((r) => fmt(r)).join(' and ')} rows over ${setup[0].G} groups in ${setup[0].W} server processes; build ${range(setup.map((s) => s.buildS), 1)} s; Node ${setup[0].node}.`)
const loc = bench.filter((d) => d.kind === 'local')
if (loc.length) {
  L.push('', '## A server reading its own groups (no wire)', '', '| way | rows | runs | ms | ns a row |', '|---|---|---|---|---|')
  for (const [k, xs] of by(loc, (d) => d.way)) L.push(`| ${k} | ${fmt(xs[0].rows)} | ${xs.length} | ${range(xs.map((x) => x.msMedian), 1)} | ${range(xs.map((x) => x.nsPerRow))} |`)
}
const pin = bench.filter((d) => d.kind === 'pin')
if (pin.length) {
  L.push('', '## A pin on a copy that folds with data (one group of 625,000 rows; field updates in batches of 256)', '', 'Each mode appears twice in a run (the order nosink, sink, pin, pinall, nosink, sink); both are in the range.', '', '| mode | lines | µs a record (median of rounds) | images kept at the end of a round | deltas the sink saw in a round |', '|---|---|---|---|---|')
  for (const [k, xs] of by(pin, (d) => d.mode)) L.push(`| ${k} | ${xs.length} | ${range(xs.map((x) => x.usPerRecord), 3)} | ${range(xs.map((x) => x.images))} | ${range(xs.map((x) => x.sinkDeltas ?? 0))} |`)
  const pm = bench.filter((d) => d.kind === 'pinmem')
  for (const [k, xs] of by(pm, (d) => d.images)) L.push('', `Memory: ${fmt(+k)} images kept, ${range(xs.map((x) => x.bytesPerImage))} B each (heap after collection, with and without them).`)
  const pc = bench.filter((d) => d.kind === 'pincopy')
  if (pc.length) L.push('', `A pin by copying the group's map of rows (rows shared): ${range(pc.map((x) => x.msMedian), 1)} ms and ${range(pc.map((x) => x.bytesPerRow))} B a row (${range(pc.map((x) => x.MB), 1)} MB).`)
}
writeFileSync(new URL('summary.md', R), L.join('\n') + '\n')
console.log(L.join('\n'))
