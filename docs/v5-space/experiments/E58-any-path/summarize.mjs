// E-58: results/summary.md from the raw lines in results/*.jsonl.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const R = join(dirname(fileURLToPath(import.meta.url)), 'results')
const lines = (f) => (existsSync(join(R, f)) ? readFileSync(join(R, f), 'utf8').split('\n').filter((l) => l.startsWith('{"exp"')).map((l) => JSON.parse(l)) : [])
const sims = lines('sims.jsonl'), muts = lines('mutants.jsonl'), tim = lines('timing.jsonl')
const md = []
const pct = (a, b) => (b === 0 ? '-' : (100 * a / b).toFixed(1) + ' %')
const sum = (s, re) => Object.entries(s).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0)
const g = (s, k) => s[k] ?? 0

md.push('# E-58: tables from the raw lines', '', 'Made by `node summarize.mjs` from `results/*.jsonl`. Each seeded line ran once under the heavy lock; a seed gives the same line every time.', '')
md.push('## Seeded runs: seeds that broke a checked rule', '', '| run | seeds | seeds failed | seconds |', '|---|---|---|---|')
for (const o of sims) md.push(`| ${o.part}${o.depth ? ' depth ' + o.depth : ''}${o.mode ? ' ' + o.mode : ''}${o.sibling !== undefined ? ' sibling ' + o.sibling : ''} | ${o.seeds} | ${o.failedSeeds} | ${o.sec} |`)

// ── part 1 ──
const CLS = ['root', 'partition', 'row', 'absent-row', 'field', 'nested', 'element', 'element-field', 'not-there']
for (const o of sims.filter((x) => x.part === 'oracle' && x.mode === 'main')) {
  const s = o.stats
  md.push('', `## Part 1, depth ${o.depth}: ${g(s, 'commits')} commits, ${g(s, 'records')} records, ${o.seeds} seeds`, '')
  md.push('Counts are lens-commits: one lens after one commit. "Changed" means the model\'s value at the lens changed.', '')
  md.push('| lens | changed | data fired | data fired, value equal: new equal object | data fired, value equal: phantom undefined | data missed | E-55 called | E-55 called, value equal: beside | E-55 called, value equal: at, above or below | log "under": changes with no record under | log "near": hits with value equal |', '|---|---|---|---|---|---|---|---|---|---|---|')
  for (const c of CLS) {
    const ch = g(s, 'changed:' + c), fired = g(s, 'count:data:' + c)
    if (fired === 0 && ch === 0) continue
    const neo = g(s, 'data:fired-unchanged:new-equal-object:' + c), ph = g(s, 'data:fired-unchanged:phantom-undefined-on-row-add:' + c)
    const e55 = g(s, 'count:e55:' + c), eb = g(s, 'e55:fired-unchanged:beside:' + c), ee = g(s, 'e55:fired-unchanged:equal-at-above-or-below:' + c) + g(s, 'e55:fired-unchanged:equal-rewrite:' + c)
    const um = g(s, 'log-under:missed:' + c), nu = g(s, 'log-near:unchanged:' + c), near = g(s, 'count:near:' + c)
    md.push(`| ${c} | ${ch} | ${fired} | ${neo} | ${ph} | 0 | ${e55} (${(e55 / Math.max(ch, 1)).toFixed(2)} per change) | ${eb} | ${ee} | ${um} (${pct(um, ch)}) | ${nu} of ${near} |`)
  }
  const below = ['field', 'nested', 'element', 'element-field', 'not-there']
  const chB = below.reduce((n, c) => n + g(s, 'changed:' + c), 0)
  md.push('', `Below a row (field, nested, element, element-field, not-there): ${chB} changes; data fired ${below.reduce((n, c) => n + g(s, 'count:data:' + c), 0)} times; E-55 called ${below.reduce((n, c) => n + g(s, 'count:e55:' + c), 0)} times; the "under" reading missed ${below.reduce((n, c) => n + g(s, 'log-under:missed:' + c), 0)} changes (${pct(below.reduce((n, c) => n + g(s, 'log-under:missed:' + c), 0), chB)}); the "near" reading missed 0.`)
  if (o.depth === 2) md.push('', `E-55 handed a row or field link a commit holding other rows of its room (not cut to the link's rows): ${sum(s, /^e55:uncut-commit:/)} lens-commits.`)
  md.push('', `Writes the leader refused: ${Object.entries(s).filter(([k]) => /^refused:/.test(k)).map(([k, v]) => k.slice(8) + ' ' + v).join('; ')}.`)
  md.push('', `Field writes v5 would refuse \`absent-path\` (a missing parent field) that data fills in: ${g(s, 'v5:absent-path-but-data-fills-in')}. Field writes under a primitive parent field (v5 silent, data makes it {}): ${g(s, 'v5:silent-primitive-parent')}.`)
  md.push('', `Part 2 on these commits: road 1 (the log records as written) sent ${g(s, 'wire:sent')} records to the client and held back ${g(s, 'wire:not-sent')} of partitions it does not hold; road 2 (E-55's c.recs(), merged per row) sent ${g(s, 'road2:sent')} and held back ${g(s, 'road2:not-sent')}. Lane rejects: ${sum(s, /^client:lane-reject/)}.`)
  // -N
  md.push('', `### -N on depth ${o.depth}: (seed, lens) pairs where the reading lands on another commit than the reference`, '', '| N | lens | pairs | data vs value | E-55 vs value | near vs value | under vs value | E-55 vs data | near vs data | under vs data |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const N of [1, 5]) for (const grp of [['row and above', ['root', 'partition', 'row', 'absent-row']], ['below a row', below]]) {
    const pairs = grp[1].reduce((n, c) => n + g(s, `minusN:${N}:near-vs-truth:pairs:${c}`), 0)
    const d = (k) => grp[1].reduce((n, c) => n + g(s, `minusN:${N}:${k}:differs:${c}`), 0)
    md.push(`| ${N} | ${grp[0]} | ${pairs} | ${pct(d('data-vs-truth'), pairs)} | ${pct(d('e55-vs-truth'), pairs)} | ${pct(d('near-vs-truth'), pairs)} | ${pct(d('under-vs-truth'), pairs)} | ${pct(d('e55-vs-data'), pairs)} | ${pct(d('near-vs-data'), pairs)} | ${pct(d('under-vs-data'), pairs)} |`)
  }
}

// ── shape runs ──
for (const o of sims.filter((x) => x.part === 'oracle' && x.mode === 'shape')) {
  const s = o.stats
  md.push('', `## Shapes v5 does not define, depth ${o.depth} (${o.seeds} seeds)`, '')
  md.push('Writes: ' + Object.entries(s).filter(([k]) => /^kind:(shape:|batch\()/.test(k)).map(([k, v]) => k.slice(5) + ' ' + v).join('; ') + '.')
  md.push('', 'Where the engine left the model (each a count of commits, by the write that caused it):', '')
  for (const [k, v] of Object.entries(s)) if (/^shape-effect:model-differs:/.test(k)) md.push(`- the row differs from a clean field write: ${k.replace('shape-effect:model-differs:', '')} ${v}`)
  for (const [k, v] of Object.entries(s)) if (/shape-client-differs-from-server:/.test(k)) md.push(`- ${k.split(':')[0]}: a client lens first differs from the server after ${k.split(':').slice(2).join(':')}: ${v}`)
  for (const [k, v] of Object.entries(s)) if (/through-string|lane-reject/.test(k)) md.push(`- ${k}: ${v}`)
}

// ── part 3 ──
for (const o of sims.filter((x) => x.part === 'split')) {
  const s = o.stats
  md.push('', `## Part 3: a write across partitions (${o.seeds} seeds)`, '')
  md.push(`- A. ${g(s, 'A:root-replaces')} root replaces over 2 to 8 partitions, ${g(s, 'A:partition-commits')} partition commits. A callback on two rows saw a mixed state in ${g(s, 'A:replaces-with-mixed-two-row-callback')} (${pct(g(s, 'A:replaces-with-mixed-two-row-callback'), g(s, 'A:root-replaces'))}); a loop that wakes after 1 to 4 commits in ${g(s, 'A:replaces-with-mixed-loop-turn')} (${pct(g(s, 'A:replaces-with-mixed-loop-turn'), g(s, 'A:root-replaces'))}); a whole-resource callback in ${g(s, 'A:replaces-with-mixed-whole-callback')}, ${g(s, 'A:mixed-whole-callback-states')} mixed states in all (${(g(s, 'A:mixed-whole-callback-states') / g(s, 'A:root-replaces')).toFixed(2)} a replace).`)
  md.push(`- B. ${g(s, 'B:moves')} moves of a row between two rooms (${g(s, 'B:remove-first')} remove first, ${g(s, 'B:add-first')} add first). A callback on both rooms saw the row in both or neither in ${g(s, 'B:moves-with-mixed-callback-state')} (${pct(g(s, 'B:moves-with-mixed-callback-state'), g(s, 'B:moves'))}); the loop in ${g(s, 'B:moves-with-mixed-loop-turn')} (${pct(g(s, 'B:moves-with-mixed-loop-turn'), g(s, 'B:moves'))}).`)
  md.push(`- C. ${g(s, 'C:replaces')} room replaces as one batch (${g(s, 'C:commits')} commits): mixed states 0 (checked; ${o.failedSeeds} seeds failed).`)
}
// ── part 4 ──
for (const o of sims.filter((x) => x.part === 'filter')) {
  const s = o.stats
  md.push('', `## Part 4: a filter on the record alone (${o.seeds} seeds, ${g(s, 'records')} records)`, '')
  md.push('Records: ' + Object.entries(s).filter(([k]) => /^records:/.test(k)).map(([k, v]) => k.slice(8) + ' ' + v).join('; ') + '.', '')
  md.push('| filter | field-only records | docs consumer misjudged | of the field-only records | entries it never sees | exits it never sees | seeds whose final set is wrong | key consumer, row consumer misjudged |', '|---|---|---|---|---|---|---|---|')
  for (const f of ['F1', 'F2']) {
    const fo = g(s, f + ':field-only-records'), m = g(s, f + ':docs:misjudged')
    md.push(`| ${f} | ${fo} | ${m} | ${pct(g(s, f + ':docs:misjudged-field-only'), fo)} | ${g(s, f + ':docs:never-sees-entry')} of ${g(s, f + ':truth:enters')} | ${g(s, f + ':docs:never-sees-exit')} of ${g(s, f + ':truth:leaves')} | ${g(s, f + ':docs:seeds-final-set-wrong')} | 0, 0 |`)
  }
  md.push('', `The docs consumer's set was wrong after ${g(s, 'F1:docs:set-wrong-after-record')} (F1) and ${g(s, 'F2:docs:set-wrong-after-record')} (F2) of ${g(s, 'records')} records. The key consumer kept ${g(s, 'F1:key:entries-kept')} (F1) and ${g(s, 'F2:key:entries-kept')} (F2) field values at the end of all seeds.`)
}
// ── part 5 ──
md.push('', '## Part 5: a version per row', '', '| sibling share | guarded writes | row guard refused | of which only a sibling changed | field guard refused | equals refused | equals passed after a change and back |', '|---|---|---|---|---|---|---|')
for (const o of sims.filter((x) => x.part === 'versions')) {
  const s = o.stats
  md.push(`| ${o.sibling} | ${g(s, 'guarded')} | ${g(s, 'row:refused')} (${pct(g(s, 'row:refused'), g(s, 'guarded'))}) | ${g(s, 'row:refused-sibling-only')} (${pct(g(s, 'row:refused-sibling-only'), g(s, 'row:refused'))}) | ${g(s, 'field:refused')} | ${g(s, 'equals:refused')} | ${g(s, 'equals:passed-aba')} |`)
}
// ── planted bugs ──
md.push('', '## Planted bugs (each must fail at least 100 of 1,000 seeds)', '', '| run | planted bug | seeds | seeds failed | first kinds |', '|---|---|---|---|---|')
for (const o of muts) md.push(`| ${o.part}${o.depth ? ' depth ' + o.depth : ''} | ${o.mutate} | ${o.seeds} | **${o.failedSeeds}** | ${Object.keys(o.failKinds).slice(0, 4).join(', ')} |`)
// ── timing ──
const range = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return lo === hi ? String(lo) : `${lo} to ${hi}` }
md.push('', '## Timed (range over the runs; each process alone under the timing lock; medians of 15 interleaved rounds)', '')
md.push('### T1: a room replaced as one batch, or row by row', '', '| rows | runs | one batch, µs | row by row, µs | ratio | sink calls (batch, row by row) |', '|---|---|---|---|---|---|')
for (const n of [...new Set(tim.filter((o) => o.bench === 'replace').map((o) => o.rows))]) {
  const xs = tim.filter((o) => o.bench === 'replace' && o.rows === n)
  md.push(`| ${n} | ${xs.length} | ${range(xs.map((o) => o.batch.usPerReplace))} | ${range(xs.map((o) => o.onebyone.usPerReplace))} | ${range(xs.map((o) => o.ratio))} | ${xs[0].batch.sinkCallsPerReplace}, ${xs[0].onebyone.sinkCallsPerReplace} |`)
}
md.push('', '### T2: what data\'s read rule costs a field link', '', '| links | runs | no links, ns a commit | E-55 rule | data\'s rule | E-55, ns a link | data\'s rule, ns a link | data\'s minus E-55, ns a link | callbacks a commit (E-55, data\'s rule) |', '|---|---|---|---|---|---|---|---|---|')
for (const n of [...new Set(tim.filter((o) => o.bench === 'rule').map((o) => o.links))]) {
  const xs = tim.filter((o) => o.bench === 'rule' && o.links === n)
  md.push(`| ${n} | ${xs.length} | ${range(xs.map((o) => o.none.nsPerCommit))} | ${range(xs.map((o) => o.e55.nsPerCommit))} | ${range(xs.map((o) => o.leaf.nsPerCommit))} | ${range(xs.map((o) => o.e55ExtraPerLinkNs))} | ${range(xs.map((o) => o.leafExtraPerLinkNs))} | ${range(xs.map((o) => o.leafMinusE55PerLinkNs))} | ${xs[0].e55.workCallsPerCommit}, ${xs[0].leaf.workCallsPerCommit} |`)
}
md.push('')
writeFileSync(join(R, 'summary.md'), md.join('\n'))
console.log(md.join('\n'))
