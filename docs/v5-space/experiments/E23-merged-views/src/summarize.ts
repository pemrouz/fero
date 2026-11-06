// Turn run A's and C's result files into tables: one row per check, one column
// per configuration, each cell "mismatches" (0 = exact at every check).
// usage: node --experimental-strip-types summarize.ts ../results > ../results/A-summary.md
import { readdirSync, readFileSync } from 'node:fs'
const dir = process.argv[2]
type Cell = { bad: number; n: number }
const runs = new Map<string, Map<string, Cell>>() // config → check → cell
const heads = new Map<string, string>()
for (const f of readdirSync(dir).filter((x) => /^[AC]-.*\.txt$/.test(x)).sort()) {
  const text = readFileSync(dir + '/' + f, 'utf8').split('\n')
  if (!text[0]?.startsWith('E-23 merge')) continue
  const m = new Map<string, Cell>()
  for (const l of text) {
    const r = /^  (ok  |DIFF) (.+?)\s+(\d+) \/\s+(\d+)/.exec(l)
    if (r) m.set(r[2].trim(), { bad: +r[3], n: +r[4] })
  }
  const cfg = f.replace(/\.txt$/, '')
  runs.set(cfg, m)
  heads.set(cfg, text[1]?.trim() ?? '')
}
const order = ['1', '4', '16', 'elastic']
// condensed: per check, per domain, mismatches summed over that domain's configurations
{
  const doms = ['int', 'float', 'dirty']
  const checks = new Set<string>()
  const tot = new Map<string, { bad: number; n: number; runs: number; badRuns: number }>()
  for (const [c, m] of runs) {
    if (!c.startsWith('A-')) continue
    const d = doms.find((x) => c.includes(`-${x}-`))!
    for (const [k, v] of m) {
      checks.add(k)
      const key = k + '|' + d
      const t = tot.get(key) ?? { bad: 0, n: 0, runs: 0, badRuns: 0 }
      t.bad += v.bad; t.n += v.n; t.runs++; if (v.bad > 0) t.badRuns++
      tot.set(key, t)
    }
  }
  console.log('### Run A, condensed: mismatches / checks, summed over every configuration of the domain (G = 1, 4, 16, elastic; mixes moves and failover)\n')
  console.log('| check | int | float | dirty |')
  console.log('|---|---:|---:|---:|')
  for (const k of [...checks].sort()) {
    const cell = (d: string) => { const t = tot.get(k + '|' + d); if (!t) return '-'; const pct = t.bad === 0 ? '' : ` (${((100 * t.bad) / t.n).toFixed(t.bad / t.n < 0.001 ? 3 : 1)}%; ${t.badRuns}/${t.runs} runs)`; return t.bad === 0 ? `0 / ${t.n}` : `**${t.bad}** / ${t.n}${pct}` }
    console.log(`| ${k} | ${cell('int')} | ${cell('float')} | ${cell('dirty')} |`)
  }
}
for (const domain of ['int', 'float', 'dirty']) {
  const cfgs = [...runs.keys()].filter((c) => c.startsWith('A-') && c.includes(`-${domain}-`))
    .sort((a, b) => {
      const ga = order.indexOf(/-g([^-]+)-/.exec(a)![1]), gb = order.indexOf(/-g([^-]+)-/.exec(b)![1])
      return ga - gb || a.localeCompare(b)
    })
  if (cfgs.length === 0) continue
  const checks = new Set<string>()
  for (const c of cfgs) for (const k of runs.get(c)!.keys()) checks.add(k)
  const label = (c: string) => c.replace(/^A-merge-g/, 'G=').replace(`-${domain}-`, ' ')
  console.log(`\n### Run A, domain ${domain}: mismatches per check (0 = exact at every check)\n`)
  console.log(`| check | ${cfgs.map(label).join(' | ')} |`)
  console.log(`|---|${cfgs.map(() => '---:').join('|')}|`)
  for (const k of [...checks].sort()) {
    const cells = cfgs.map((c) => { const x = runs.get(c)!.get(k); return x === undefined ? '-' : x.bad === 0 ? '0' : `**${x.bad}**` })
    console.log(`| ${k} | ${cells.join(' | ')} |`)
  }
  console.log(`\nChecks per cell (the n behind each count) are in the raw files. Runs:`)
  for (const c of cfgs) console.log(`- ${label(c)}: ${heads.get(c)}`)
}
const cs = [...runs.keys()].filter((c) => c.startsWith('C-')).sort()
if (cs.length) {
  console.log(`\n### Run C: a slot move seen as two cuts (int domain). Mismatches at the cut between the two halves of a move\n`)
  const checks = new Set<string>()
  for (const c of cs) for (const k of runs.get(c)!.keys()) if (k.startsWith('mid-move: ')) checks.add(k)
  console.log(`| check (between fence and open) | ${cs.map((c) => c.replace(/^C-move-/, '')).join(' | ')} |`)
  console.log(`|---|${cs.map(() => '---:').join('|')}|`)
  for (const k of [...checks].sort()) {
    const cells = cs.map((c) => { const x = runs.get(c)!.get(k); return x === undefined ? '-' : `${x.bad} / ${x.n}` })
    console.log(`| ${k.replace('mid-move: ', '')} | ${cells.join(' | ')} |`)
  }
  console.log(`\nAfter the second half of every move (the "move" cut) the checks above return to Run A's counts; see the raw files.`)
  for (const c of cs) console.log(`- ${c}: ${heads.get(c)}`)
}

// ── run B: history independence, per view, per domain (G = 4 and 16 summed) ──
{
  const files = readdirSync(dir).filter((x) => /^B-interleave-.*\.txt$/.test(x)).sort()
  if (files.length) {
    const tot = new Map<string, { bad: number; n: number }>()
    const views: string[] = []
    for (const f of files) {
      const d = /-(int|float|dirty)\.txt$/.exec(f)![1]
      for (const l of readFileSync(dir + '/' + f, 'utf8').split('\n')) {
        const r = /^  (ok  |DIFF) (.+?)\s{2,}(interleave|rebuilt|snapshot) (values|bytes)\s+(\d+) \/\s+(\d+)/.exec(l)
        if (!r) continue
        const v = r[2].trim()
        if (!views.includes(v)) views.push(v)
        const key = `${v}|${r[3]}|${r[4]}|${d}`
        const t = tot.get(key) ?? { bad: 0, n: 0 }
        t.bad += +r[5]; t.n += +r[6]
        tot.set(key, t)
      }
    }
    const cell = (v: string, how: string, kind: string, d: string) => {
      const t = tot.get(`${v}|${how}|${kind}|${d}`)
      return t === undefined ? '-' : t.bad === 0 ? '0' : `**${t.bad}/${t.n}**`
    }
    console.log('\n### Run B: views that differ, as values (bytes in brackets where only the order differs), G = 4 and 16 summed\n')
    console.log('Each cell: comparisons that differed / comparisons made. "interleave" = two servers that fold every group, interleaved differently; "rebuilt" = a fresh view on the same source; "snapshot" = a fresh source loaded from the rows in key order.\n')
    console.log('| view | int: interleave | rebuilt | snapshot | float: interleave | rebuilt | snapshot | dirty: interleave | rebuilt | snapshot |')
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const v of views) {
      const cells: string[] = []
      for (const d of ['int', 'float', 'dirty']) for (const how of ['interleave', 'rebuilt', 'snapshot']) {
        const val = cell(v, how, 'values', d)
        const byt = cell(v, how, 'bytes', d)
        cells.push(val === '0' && byt !== '0' ? `0 (bytes ${byt.replace(/\*/g, '')})` : val)
      }
      console.log(`| ${v} | ${cells.join(' | ')} |`)
    }
  }
}
