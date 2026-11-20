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
console.log('| mode | link on | runs | achieved writes/s | turns | commits the loop saw | commits per turn | waiting at the end | most waiting | heap growth MB | bytes per waiting commit | waiting grows a second |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
// how fast the waiting count grows: from the first sample to the last, per run
const growth = (o) => { const s = o.samples ?? []; if (s.length < 2) return undefined; const a = s[0], b = s[s.length - 1]; return Math.round((b.waiting - a.waiting) / ((b.ms - a.ms) / 1000)) }
for (const mode of ['merge', 'every']) for (const shape of ['row', 'whole']) {
  const g = lines.filter((o) => o.part === 'grow' && o.mode === mode && o.shape === shape)
  if (!g.length) continue
  const f = (k) => rng(g.map((o) => o[k]))
  console.log(`| ${mode} | ${shape === 'row' ? 'one row' : 'the whole resource (1,000 rows)'} | ${g.length} | ${f('achievedRate')} | ${f('turns')} | ${f('commitsSeenByTheLoop')} | ${f('commitsPerTurn')} | ${f('waitingAtEnd')} | ${f('maxWaiting')} | ${f('heapGrowthMB')} | ${f('bytesPerWaitingCommit')} | ${mode === 'every' ? rng(g.map(growth)) : ''} |`)
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

const sg = lines.filter((o) => o.part === 'signal')
if (sg.length) {
  console.log(`\n### Probe 4b: what { signal } and { until } cost a link (${sg.length} runs; each run the median of ${sg[0].rounds} interleaved rounds; ns a link)\n`)
  console.log('One signal shared by n links, alone (no fero): a listener per link, against one listener per signal and a Set of its links.\n')
  console.log('| links on one signal | a listener per link: add | its remove | one listener and a Set: add | its remove |')
  console.log('|---|---|---|---|---|')
  for (const n of Object.keys(sg[0].mechanism)) { const m = (k) => rng(sg.map((o) => o.mechanism[n][k])); console.log(`| ${Number(n).toLocaleString('en')} | ${m('perLinkAdd')} | ${m('perLinkRemove')} | ${m('perSignalAdd')} | ${m('perSignalRemove')} |`) }
  console.log('\nThe prototype (a listener per link, as built): n links on one row of a server, connect() then disconnect(), ns a link for both.\n')
  console.log('| links | no end option | { signal } (one shared) | { until } (one socket-like thing) | signal over none | until over none |')
  console.log('|---|---|---|---|---|---|')
  for (const n of Object.keys(sg[0].connect)) { const m = (k) => rng(sg.map((o) => o.connect[n][k])); console.log(`| ${Number(n).toLocaleString('en')} | ${m('none')} | ${m('signal')} | ${m('until')} | ${m('signalOverNone')} | ${m('untilOverNone')} |`) }
}
