// E-57 group A: the tables of results/summary.md, made from the raw lines in results/.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const R = join(dirname(fileURLToPath(import.meta.url)), 'results')
const lines = (f) => (existsSync(join(R, f)) ? readFileSync(join(R, f), 'utf8').split('\n').filter((l) => l.startsWith('{"exp"')).map((l) => JSON.parse(l)) : [])
const md = []
const keys = ['checks', 'framesApplied', 'clientPictures', 'unequal', 'settledUnequal', 'backInTime', 'doubled', 'missed', 'disconnects', 'clientRingResumes', 'resumePictures', 'kills', 'leaderKills', 'leaderEntries', 'xa4Unequal', 'xa4Unchanged', 'xa5Unequal', 'xa6Checks', 'xa6Unequal', 'leaked', 'denied', 'dupViews', 'crossDup', 'capExceeded', 'admitMismatch', 'admits', 'refusedCap', 'refusedHeld', 'tooBig', 'rebuildAfterTooBig', 'warn80', 'sinkAfterEnd', 'sinkAfterDispose', 'leftViews', 'leftEntries', 'calls', 'callUnequal', 'getsChecked', 'getUnequal', 'fallbacks', 'oldVersionFrames', 'versionBack', 'ref_stale-client', 'staleShape', 'syncs', 'syncFail', 'costExceeded', 'buildsOnSnapshot', 'lingerReuses', 'ringResumes', 'ringFrames', 'resumeBytes', 'pictureBytes', 'frames', 'frameBytes', 'encodes', 'sends', 'waits', 'pageReads']
const row = (o) => { const t = o.stats ?? {}; return keys.filter((k) => t[k]).map((k) => k + ' ' + t[k]).join(', ') }

md.push('# E-57 group A: tables from the raw lines', '', 'Made by `node summarize.mjs` from `results/*.jsonl`. Every seeded line ran once under the heavy lock (a seed gives the same line every time).', '')
md.push('## Seeded runs (no planted bug)', '', '| run | seeds | seeds failed | why | counters (non-zero) |', '|---|---|---|---|---|')
for (const o of lines('sims.jsonl')) if (o.seeds) md.push(`| ${o.claim} | ${o.seeds} | ${o.failedSeeds} | ${JSON.stringify(o.failKinds).replace(/\|/g, '/')} | ${row(o)} |`)
md.push('', '### Deterministic runs', '')
for (const o of lines('sims.jsonl')) if (!o.seeds) { const { exp, group, node, mutate, ...rest } = o; md.push('- `' + JSON.stringify(rest) + '`') }
md.push('', '## Planted bugs (each must fail at least 100 of 1,000 seeds)', '', '| run | planted bug | seeds | seeds failed | why (first kinds) |', '|---|---|---|---|---|')
for (const o of lines('mutants.jsonl')) if (o.seeds) md.push(`| ${o.claim} | ${o.mutate ?? '(impure view)'} | ${o.seeds} | **${o.failedSeeds}** | ${JSON.stringify(o.failKinds).slice(0, 160).replace(/\|/g, '/')} |`)
md.push('')
for (const o of lines('mutants.jsonl')) if (!o.seeds) { const { exp, group, node, ...rest } = o; md.push('- `' + JSON.stringify(rest) + '`') }

// timed: the range over runs of every number, per bench and size
const T = lines('timing.jsonl')
const flat = (o, p = '', acc = {}) => { for (const [k, v] of Object.entries(o)) { if (['exp', 'group', 'node', 'claim', 'bench', 'rows'].includes(k)) continue; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p + k + '.', acc); else if (typeof v === 'number') acc[p + k] = v } return acc }
const by = new Map()
for (const o of T) { const k = o.bench + ' @ ' + o.rows; if (!by.has(k)) by.set(k, []); by.get(k).push(flat(o)) }
md.push('', '## Timed (range over the runs; each process alone under the timing lock)', '')
for (const [k, runs] of by) {
  md.push(`### ${k} (${runs.length} runs)`, '', '| number | range |', '|---|---|')
  for (const m of Object.keys(runs[0])) { const xs = runs.map((r) => r[m]).filter((x) => x !== undefined); const lo = Math.min(...xs), hi = Math.max(...xs); md.push(`| ${m} | ${lo === hi ? lo : lo + ' to ' + hi} |`) }
  md.push('')
}
const ty = lines('types.jsonl')
if (ty.length) { md.push('## Types (XA-11)', ''); for (const o of ty) md.push('- `' + JSON.stringify(o) + '`') }
writeFileSync(join(R, 'summary.md'), md.join('\n') + '\n')
console.log('wrote results/summary.md:', md.length, 'lines')
