// E-64 O3: the tables, from results/sim.jsonl and results/bench.jsonl. Timed cells are min to max over the runs.
import { readFileSync, existsSync } from 'node:fs'
const here = new URL('../results/', import.meta.url)
const lines = (f) => (existsSync(new URL(f, here)) ? readFileSync(new URL(f, here), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [])
const sim = lines('sim.jsonl'), bench = lines('bench.jsonl').filter((o) => o.exp)
const out = []
const p = (s) => out.push(s)
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n))
const range = (xs) => { const a = xs.filter((x) => typeof x === 'number'); if (!a.length) return '—'; const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}` }

p('# E-64 O3: results\n')
p('## Seeded runs: long runs (one seed, every frame checked)\n')
p('| groups | early | commits | checks | mismatches | moves (slots) | grows / shrinks | host failovers | outages | duplicates | merged runs | combiner rebuilds | pictures taken | frames dropped (S2) | torn commits (states seen) | seconds |')
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const o of sim.filter((o) => o.seeds === undefined)) {
  const e = o.events, c = o.combiner
  p(`| ${o.groups} | ${o.early ? 'yes' : 'no'} | ${fmt(o.commits)} | ${fmt(o.checks)} | ${fmt(o.mismatches)} | ${fmt(o.moves)} (${fmt(o.slotMoves)}) | ${o.grows} / ${o.shrinks} | ${e.hostFailovers} | ${e.outages} | ${e.duplicates} | ${fmt(e.merges)} | ${e.rebuilds} | ${fmt(c.pictures)} | ${fmt(c.dropped)} | ${fmt(e.tornCommits)} of ${fmt(e.multiCommits)} (${fmt(e.tornSeen)}) | ${o.seconds} |`)
}
p('\n## Seeded runs: 1,000 short seeds each (400 commits, 300 keys)\n')
p('| groups | code | seeds failed | checks | mismatches | first failure |')
p('|---|---|---|---|---|---|')
for (const o of sim.filter((o) => o.seeds !== undefined)) {
  const code = o.mutate ? `planted: ${o.mutate}` : o.early ? 'variant: early' : 'real'
  p(`| ${o.groups} | ${code} | ${o.seedsFailed} of ${o.seeds} | ${fmt(o.checks)} | ${fmt(o.mismatches)} | ${o.first ? ('`' + o.first.firstBad.slice(0, 70).replace(/\|/g, '/') + '`') : '—'} |`)
}

const by = (part) => bench.filter((o) => o.part === part)
const group = (xs, keyf) => { const m = new Map(); for (const o of xs) { const k = keyf(o); if (!m.has(k)) m.set(k, []); m.get(k).push(o) } return m }
p('\n## Host: keeping per-slot partials, per write (S = 4,096; three runs, min to max)\n')
p('| view | N | B | rows a slot | ns a write | frame entries a write | cells a write |')
p('|---|---|---|---|---|---|---|')
for (const [, xs] of group(by('host'), (o) => `${o.view}|${o.N}|${o.B}`)) { const o = xs[0]; p(`| ${o.view} | ${fmt(o.N)} | ${o.B} | ${o.rowsPerSlot.toFixed(0)} | ${range(xs.map((x) => x.nsPerWrite))} | ${o.entriesPerWrite} | ${o.cellsPerWrite} |`) }
p('\n## Combiner: applying those frames (three runs, min to max)\n')
p('| view | N | B | ns a frame entry | ns a cell | ns a source write | window candidates |')
p('|---|---|---|---|---|---|---|')
for (const [, xs] of group(by('comb'), (o) => `${o.view}|${o.N}|${o.B}`)) { const o = xs[0]; p(`| ${o.view} | ${fmt(o.N)} | ${o.B} | ${range(xs.map((x) => x.nsPerEntry))} | ${range(xs.map((x) => x.nsPerCell))} | ${range(xs.map((x) => x.nsPerWrite))} | ${fmt(o.candidates)} |`) }
p('\n## The delta form, for comparison: counts and exact sums per bucket (three runs, min to max)\n')
p('| N | B | copy: ns a write | combiner: ns a frame | frame JSON bytes |')
p('|---|---|---|---|---|')
for (const [, xs] of group(by('delta'), (o) => `${o.N}|${o.B}`)) { const o = xs[0]; p(`| ${fmt(o.N)} | ${o.B} | ${range(xs.map((x) => x.hostNsPerWrite))} | ${range(xs.map((x) => x.combNsPerFrame))} | ${o.frameJsonBytes} |`) }
p('\n## Windows: frames a write, partials by slot against by group (counts)\n')
p('| N | K | scores | by slot (4,096) | G = 4 | G = 16 | G = 64 | G = 256 |')
p('|---|---|---|---|---|---|---|---|')
for (const [, xs] of group(by('rate').filter((o) => o.run === 1 || o.run === 0), (o) => `${o.N}|${o.K}|${o.work}`)) {
  const f = (g) => xs.find((x) => String(x.G) === String(g))?.framesPerWrite ?? '—'
  const o = xs[0]
  p(`| ${fmt(o.N)} | ${o.K} | ${o.work} | ${f('slot')} | ${f(4)} | ${f(16)} | ${f(64)} | ${f(256)} |`)
}
p('\n## A partials resource: partial-row writes per source write, frames merged per window (counts)\n')
p('| keys | writes a second | window | by slot: row writes a write | by slot: a second | by group (G = 16): a write | by group: a second |')
p('|---|---|---|---|---|---|---|')
for (const o of by('coalesce').filter((o) => o.run === 1 || o.run === 0)) p(`| ${o.keys} | ${fmt(o.ratePerSec)} | ${o.windowMs} ms | ${o.slotRowWritesPerWrite} | ${fmt(o.slotRowWritesPerSec)} | ${o.groupRowWritesPerWrite} | ${fmt(o.groupRowWritesPerSec)} |`)
p('\n## Combiner memory (heap after a full collection; three runs, min to max)\n')
p('| what | form | partials | B or K | cells or rows | bytes | bytes a cell or row |')
p('|---|---|---|---|---|---|---|')
for (const [, xs] of group(by('mem'), (o) => `${o.what}|${o.form ?? ''}|${o.partials}|${o.B ?? o.K}`)) { const o = xs[0]; const small = xs.some((x) => x.bytes < 0); p(`| ${o.what} | ${o.form ?? 'slot/group'} | ${fmt(o.partials)} | ${o.B ?? o.K} | ${fmt(o.cells ?? o.rows)} | ${small ? 'below the heap\'s noise' : range(xs.map((x) => x.bytes))} | ${small ? '—' : range(xs.map((x) => x.bytesPerCell ?? x.bytesPerRow))} |`) }
p('\n## Bytes (JSON, a stand-in for the codec; counts)\n')
p('| N | B | by-bucket cells | sum | max | top 10 | filter | entries a write | a picture of one slot |')
p('|---|---|---|---|---|---|---|---|---|')
for (const o of by('bytes').filter((o) => o.run === 1 || o.run === 0)) { const b = o.bytesPerWrite; p(`| ${fmt(o.N)} | ${o.B} | ${b.by} | ${b.sum} | ${b.max} | ${b.top} | ${b.gt} | ${o.entriesPerWrite} | ${fmt(o.pictureBytesPerSlot)} |`) }
const loads = lines('bench.jsonl').filter((o) => o.loadavg).map((o) => +o.loadavg.split(' ')[0])
if (loads.length) p(`\n1-minute load average when each timed process was queued: ${Math.min(...loads)} to ${Math.max(...loads)}.`)
console.log(out.join('\n'))
