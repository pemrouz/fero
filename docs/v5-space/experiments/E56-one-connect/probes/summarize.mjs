// The timed tables from results/timing.jsonl, as "lowest-highest" over the runs (each run one process alone under
// the timing lock). Prints Markdown.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lines = readFileSync(join(here, 'results', 'timing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.exp === 'E-56')
const rng = (xs) => { const v = xs.filter((x) => typeof x === 'number'); if (!v.length) return 'n/a'; const lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? String(lo) : `${lo} to ${hi}` }
const failed = lines.filter((o) => o.part === 'failed')
if (failed.length) console.log(`**${failed.length} failed runs**: ${failed.map((f) => f.cmd).join('; ')}\n`)

console.log('### Probe 2: a for-await loop 10 times slower than the writes (10,000 commits a second for 5 s)\n')
console.log('| mode | link on | runs | achieved writes/s | turns | commits the loop saw | commits per turn | waiting at the end | most waiting | heap growth MB | bytes per waiting commit |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const mode of ['merge', 'every']) for (const shape of ['row', 'whole']) {
  const g = lines.filter((o) => o.part === 'grow' && o.mode === mode && o.shape === shape)
  if (!g.length) continue
  const f = (k) => rng(g.map((o) => o[k]))
  console.log(`| ${mode} | ${shape === 'row' ? 'one row' : 'the whole resource (1,000 rows)'} | ${g.length} | ${f('achievedRate')} | ${f('turns')} | ${f('commitsSeenByTheLoop')} | ${f('commitsPerTurn')} | ${f('waitingAtEnd')} | ${f('maxWaiting')} | ${f('heapGrowthMB')} | ${f('bytesPerWaitingCommit')} |`)
}

const c = lines.filter((o) => o.part === 'cost')
if (c.length) {
  console.log(`\n### Probe 2: ns per commit, one link on the whole resource (${c.length} runs; each run the median of 7 interleaved rounds)\n`)
  console.log('| way | ns a commit | over no link (inside each round) |')
  console.log('|---|---|---|')
  for (const k of Object.keys(c[0].nsPerCommit)) console.log(`| ${k} | ${rng(c.map((o) => o.nsPerCommit[k]))} | ${k in c[0].overNone ? rng(c.map((o) => o.overNone[k])) : ''} |`)
  console.log(`| for await (every, bursts of 100), over the callback | | ${rng(c.map((o) => o.forAwaitOverCallback['every-burst100']))} |`)
  console.log(`| for await (merged, bursts of 100), over the callback | | ${rng(c.map((o) => o.forAwaitOverCallback['merge-burst100']))} |`)
  console.log(`| for await one commit at a time (every), over the writer's own await | | ${rng(c.map((o) => o.pingpongOverItsOwnWait.every))} |`)
  console.log(`| for await one commit at a time (merged), over the writer's own await | | ${rng(c.map((o) => o.pingpongOverItsOwnWait.merge))} |`)
}

for (const K of [1, 10]) {
  const p = lines.filter((o) => o.part === 'prev' && o.changesPerCommit === K)
  if (!p.length) continue
  console.log(`\n### Probe 3: what reading the commit costs, ${K} change${K > 1 ? 's' : ''} a commit (${p.length} runs; each run the median of 9 interleaved rounds)\n`)
  console.log('| way | ns a commit | over no link | over a callback that reads nothing |')
  console.log('|---|---|---|---|')
  for (const k of Object.keys(p[0].nsPerCommit)) console.log(`| ${k} | ${rng(p.map((o) => o.nsPerCommit[k]))} | ${k in p[0].overNone ? rng(p.map((o) => o.overNone[k])) : ''} | ${k in p[0].overNothing ? rng(p.map((o) => o.overNothing[k])) : ''} |`)
  console.log(`| diff over recs | | | ${rng(p.map((o) => o.diffOverRecs))} |`)
  console.log(`\nThe same work alone, no writes in the timed loop: ns per change over ${p[0].capturedChanges} captured changes (${p.length} runs; each the median of 9 interleaved rounds)\n`)
  console.log('| way | ns a change |')
  console.log('|---|---|')
  for (const k of Object.keys(p[0].aloneNsPerChange)) console.log(`| ${k} | ${rng(p.map((o) => o.aloneNsPerChange[k]))} |`)
}
