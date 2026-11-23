// E-65 X3: results/summary.md from results/sim.jsonl and results/bench.jsonl
import { readFileSync, existsSync } from 'node:fs'
const load = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const sim = load('results/sim.jsonl'), bench = load('results/bench.jsonl')
const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(x))
const range = (xs) => { const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b); if (!s.length) return '-'; return s[0] === s[s.length - 1] ? fmt(s[0]) : fmt(s[0]) + ' to ' + fmt(s[s.length - 1]) }
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.map(fmt).join(' | ') + ' |')].join('\n')
const world = (l) => l.groups + (l.deploy ? ', deploy (overlap ' + l.overlap + ')' : '') + (l.keeps ? '' : ', no keeps') + (l.flat ? ', flat' : '') + ' (' + l.commits + ' commits, ' + l.keys + ' keys)'
const out = []
out.push('# E-65 X3 results\n')
out.push('Made by `src/summarize.mjs` from `sim.jsonl` and `bench.jsonl`. Seeded runs are *(checked)*; timed cells are *(measured)*, a range over three runs, each the median of 5 rounds.\n')
out.push('## Lawful folds (the six folds of `src/folds.mjs`), every world\n')
out.push(table(['world', 'seeds', 'failed', 'flagged by fero', 'checks', 'paired moves', 'slots moved', 'resyncs (at cut)', 'outages', 'rebuilds', 'deploys', 'deploy stall steps', 'rescans', 'kept by hint'],
  sim.filter((l) => l.bug === 'none' && l.mutate === 'none').map((l) => [world(l), l.seeds, l.failed, l.anyFero, l.checks, l.pairs, l.slotsMoved, l.resyncs + ' (' + l.atCut + ')', l.outages, l.rebuilds, l.deployed, l.stallSteps, l.rescans, l.kept])))
out.push('\n## Planted builder bugs (fero\'s side), failing seeds\n')
out.push(table(['bug', 'world', 'failed', 'of seeds', 'first failure'], sim.filter((l) => l.mutate !== 'none').map((l) => [l.mutate, world(l), l.failed, l.seeds, l.firsts?.[0] ? l.firsts[0].what : '-'])))
out.push('\n## An author\'s mistakes: who sees them (seeds out of the run\'s seeds)\n')
out.push(table(['mistake', 'seeds', 'oracle saw a wrong answer', 'wrong answers / checks', 'self-check at build', 'law it named', 'audit', 'resync check', 'any of fero\'s checks', 'a move changed an answer'],
  sim.filter((l) => l.bug !== 'none').map((l) => [l.bug, l.seeds, l.failed, (l.checks ? (100 * l.mismatches / l.checks).toFixed(1) : 0) + ' %', l.selfFlagged, Object.entries(l.laws).map(([k, v]) => k + ' ' + v).join(', ') || '-', l.auditFlagged, l.driftFlagged, l.anyFero, l.flickerSeeds])))
const grp = (rows, keyf) => { const m = new Map(); for (const r of rows) { const k = keyf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r) } return m }
const P = bench.filter((b) => b.part === 'partial' && !b.quick)
if (P.length) {
  out.push('\n## The partial\'s work per write on a group copy (N rows, G groups, 4,096 slots)\n')
  out.push(table(['N', 'G', 'rows a slot', 'fold', 'class', 'form', 'µs a write', 'rows rescanned a write', 'combines a write', 'frame parts a write', 'runs'],
    [...grp(P, (b) => [b.N, b.G, b.fold, b.form].join('|')).values()].map((rs) => { const b = rs[0]; return [b.N, b.G, b.rowsPerSlot.toFixed(0), b.fold, b.cls, b.form, range(rs.map((r) => r.nsPerWrite / 1000)), range(rs.map((r) => r.rescanRowsPerWrite)), range(rs.map((r) => r.combinesPerWrite)), range(rs.map((r) => r.framePartsPerWrite)), rs.length] })))
}
const Mg = bench.filter((b) => b.part === 'merger' && !b.quick)
if (Mg.length) {
  out.push('\n## The merger\'s work per write (G groups, B writes folded into one partial frame)\n')
  out.push(table(['G', 'B', 'fold', 'class', 'ns a write', 'frame parts a write', 'writes a second (one thread)', 'runs'],
    [...grp(Mg, (b) => [b.fold, b.G, b.B].join('|')).values()].map((rs) => { const b = rs[0]; return [b.G, b.B, b.fold, b.cls, range(rs.map((r) => r.nsPerWrite)), range(rs.map((r) => r.partsPerWrite)), range(rs.map((r) => r.writesPerSec)), rs.length] })))
}
const C = bench.filter((b) => b.part === 'check' && !b.quick)
if (C.length) {
  out.push('\n## fero\'s checks: the self-check at build (200 trials over 64 rows) and the audit (pieces again from the rows)\n')
  out.push(table(['fold', 'self-check ms', 'audit ns a row (25,000 rows)', 'audit ms at 250,000 rows'],
    [...grp(C, (b) => b.fold).values()].map((rs) => [rs[0].fold, range(rs.filter((r) => r.what === 'selfcheck').map((r) => r.msPerCheck)), range(rs.filter((r) => r.what === 'audit' && r.rows === 25000).map((r) => r.nsPerRow)), range(rs.filter((r) => r.what === 'audit' && r.rows === 250000).map((r) => r.msPerAudit))])))
}
console.log(out.join('\n'))
