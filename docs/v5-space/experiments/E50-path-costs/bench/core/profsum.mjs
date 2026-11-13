// Sum a V8 .cpuprofile by self time: per area (fero api, fero kernel, data, GC, other) and the top functions.
//   node profsum.mjs <file.cpuprofile> [top]
import fs from 'node:fs'
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const top = Number(process.argv[3] ?? 25)
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const self = new Map()
const dts = p.timeDeltas
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i]
  const dt = dts[i + 1] ?? 0
  self.set(id, (self.get(id) ?? 0) + dt)
}
const area = (cf) => {
  const u = cf.url || ''
  if (cf.functionName === '(garbage collector)') return 'gc'
  if (cf.functionName === '(idle)' || cf.functionName === '(program)' || cf.functionName === '(root)') return 'idle/program'
  if (u.includes('/fero/api/data.ts')) return 'fero api/data.ts (Bind: issue, outcome, settle)'
  if (u.includes('/fero/api/substrate.ts')) return 'fero api/substrate.ts (lens, applyRec)'
  if (u.includes('/fero/api/')) return 'fero api other'
  if (u.includes('/fero/kernel/codec.ts')) return 'fero kernel/codec.ts'
  if (u.includes('/fero/kernel/')) return 'fero kernel other (node, write, link, journal)'
  if (u.includes('/fero/shell/')) return 'fero shell'
  if (u.includes('/data/')) return 'data (fold, views)'
  if (u.endsWith('/core/api.ts') || u.includes('core-bench/api.ts')) return 'bench driver'
  if (u === '') return 'native/builtins'
  return 'node internals'
}
const areas = new Map()
const fns = new Map()
let total = 0
for (const [id, t] of self) {
  const n = byId.get(id)
  const cf = n.callFrame
  const a = area(cf)
  if (a === 'idle/program') continue
  total += t
  areas.set(a, (areas.get(a) ?? 0) + t)
  const repo = (cf.url || '').includes('pemrouz/data') ? 'data:' : (cf.url || '').includes('/tree/fero/') ? 'fero:' : ''
  const k = `${cf.functionName || '(anon)'} ${repo}${(cf.url || '').split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`
  fns.set(k, (fns.get(k) ?? 0) + t)
}
const out = { total_ms: +(total / 1000).toFixed(1), areas: {}, top: [] }
for (const [a, t] of [...areas].sort((x, y) => y[1] - x[1])) out.areas[a] = +((100 * t) / total).toFixed(1)
for (const [k, t] of [...fns].sort((x, y) => y[1] - x[1]).slice(0, top)) out.top.push([k, +((100 * t) / total).toFixed(1)])
console.log(JSON.stringify(out, null, 1))
