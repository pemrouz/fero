// E-65 X5: results/summary.md from the JSON lines. Usage: node summarize.mjs <results folder>
import { readFileSync, existsSync } from 'node:fs'
const R = process.argv[2]
const lines = (f) => (existsSync(R + '/' + f) ? readFileSync(R + '/' + f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const range = (xs) => { const a = Math.min(...xs), b = Math.max(...xs); return a === b ? String(a) : a + ' to ' + b }
const pct = (x) => (100 * x).toFixed(1) + ' %'
const out = []
out.push('# E-65 X5: summary of the raw results', '', 'Made by `./run.sh summary` from the JSON lines in this folder.', '')

// ---- sample
const runs = lines('sample-runs.jsonl'), seeds = lines('sample.jsonl')
out.push('## Slot sample (`sample.mjs`, checked)', '')
out.push('Each seed: one resource and one stream of 20,000 writes, folded by 20 independent picks of k slots. A seed fails if any held row differs from the oracle (exact check), or if any estimate\'s 95 % interval holds the truth in fewer than 14 of 20 picks.', '')
out.push('| Config | Seeds | Failed | Cover: count | sum | mean | paid | median | p90 |', '|---|---|---|---|---|---|---|---|---|')
for (const r of runs) {
  const c = r.coverRate
  out.push(`| ${r.bug === 'none' ? 'real' : 'bug ' + r.bug}, ${r.tail}, k ${r.k}, ${r.parts}+ partitions | ${r.seeds} | ${r.failed} | ${pct(c.count)} | ${pct(c.sum)} | ${pct(c.mean)} | ${pct(c.paid)} | ${pct(c.median)} | ${pct(c.p90)} |`)
}
out.push('')
const groups = {}
for (const s of seeds) if (s.bug === 'none') (groups[`${s.tail}, k ${s.k}, ${s.parts > 10000 ? 'many' : 'few'} partitions`] ??= []).push(s)
out.push('Real code, per seed (ranges over seeds): rows at the end, rows held, share of writes sent to the asker, interval half-width as a share of the truth, and two things a sample cannot estimate.', '')
out.push('| Config | Rows | Held | Sent | ± count | ± sum | ± mean | ± median | ± p90 | distinct sku scaled / true | sample max / true max |', '|---|---|---|---|---|---|---|---|---|---|---|')
for (const [k, ss] of Object.entries(groups)) {
  const hw = (n) => range(ss.map((s) => +(100 * s.halfWidthRel[n]).toFixed(1))) + ' %'
  out.push(`| ${k} | ${range(ss.map((s) => s.rows))} | ${range(ss.map((s) => s.heldRows))} | ${range(ss.map((s) => +(100 * s.sentFrac).toFixed(2)))} % | ${hw('count')} | ${hw('sum')} | ${hw('mean')} | ${hw('median')} | ${hw('p90')} | ${range(ss.map((s) => s.distinctRatio))} | ${range(ss.map((s) => s.maxRatio))} |`)
}
out.push('')

// ---- clientmerge
const cm = lines('clientmerge.jsonl')
out.push('## Clients that merge (`clientmerge.mjs`, counted and checked)', '')
out.push('| G | Scores | Bug | Seeds | Failed | Top 10: partial frames a write | merged frames a write | ratio | Sums: partial | merged |', '|---|---|---|---|---|---|---|---|---|---|')
const keyOf = (r) => `${r.G}|${r.mode}|${r.bug}`
const by = {}
for (const r of cm) if (r.seed) (by[keyOf(r)] ??= []).push(r)
for (const [k, rs] of Object.entries(by)) {
  const [G, mode, bug] = k.split('|')
  const p = rs.map((r) => r.top10.partialFramesPerWrite), m = rs.map((r) => r.top10.mergedFramesPerWrite)
  out.push(`| ${G} | ${mode} | ${bug} | ${rs.length} | ${rs.filter((r) => r.fail).length} | ${range(p)} | ${range(m)} | ${range(rs.map((r) => +(r.top10.partialFramesPerWrite / Math.max(1e-9, r.top10.mergedFramesPerWrite)).toFixed(1)))} | ${range(rs.map((r) => r.sums.partialFramesPerWrite))} | ${range(rs.map((r) => r.sums.mergedFramesPerWrite))} |`)
}
out.push('')
const first = cm.find((r) => r.seed === 1 && r.bug === 'none' && r.mode === 'random' && r.G === 16 && r.placements)
const firstR = cm.find((r) => r.seed === 1 && r.bug === 'none' && r.mode === 'rising' && r.G === 16 && r.placements)
if (first) {
  out.push('Sends a write by placement, G = 16, seed 1 (M: one merger; MR: a merger and one relay per 1,000 clients; CM: clients merge). "Busiest" is the one process that sends the most.', '')
  out.push('| View | Clients | M busiest | MR busiest | CM busiest | M total | CM total | Frames a client takes, M / CM | Links a client, M / CM |', '|---|---|---|---|---|---|---|---|---|')
  for (const [name, src] of [['top 10, random', first.placements.top10], ['top 10, rising', firstR?.placements.top10], ['sums', first.placements.sums]]) {
    if (!src) continue
    for (const p of src) out.push(`| ${name} | ${p.C} | ${p.M.busiestSendsPerWrite} | ${p.MR.busiestSendsPerWrite} | ${p.CM.busiestSendsPerWrite} | ${p.M.totalSendsPerWrite} | ${p.CM.totalSendsPerWrite} | ${p.M.clientRecvPerWrite} / ${p.CM.clientRecvPerWrite} | ${p.M.linksPerClient} / ${p.CM.linksPerClient} |`)
  }
  out.push('')
}

// ---- timing
const t = lines('timing.jsonl')
const sb = t.filter((x) => x.part === 'sample-bench'), cb = t.filter((x) => x.part === 'cm-bench')
const loads = t.filter((x) => x.loadavg).map((x) => x.loadavg.split(' ')[0])
out.push('## Timing (measured, each run alone under the timing lock)', '')
out.push(`Runs: ${sb.length}. Load average (1 min) at each run's start: ${loads.join(', ')}.`, '')
if (sb.length) {
  out.push('| Cell | Range over runs |', '|---|---|')
  out.push(`| copy: drop a record of a slot not held (bitmap test) | ${range(sb.map((x) => x.filter.nsPerRecord))} ns a record |`)
  for (const h of ['held62500', 'held625000']) {
    out.push(`| asker, ${h.slice(4)} rows held: fold one sampled update (per-slot sums and sorted columns) | ${range(sb.map((x) => x[h].foldNsPerWrite))} ns |`)
    out.push(`| asker, ${h.slice(4)} rows held: one read (count, mean with intervals; median with Woodruff's interval) | ${range(sb.map((x) => x[h].readUs))} µs |`)
  }
  for (const G of [16, 256]) out.push(`| client: merge one partial top-10 frame, G = ${G} | ${range(cb.map((x) => x.top10.find((y) => y.G === G).nsPerFrame))} ns |`)
}
console.log(out.join('\n'))
