// print one short line per run.mjs JSON line (stdin)
const lines = require('fs').readFileSync(0, 'utf8').split('\n').filter((l) => l.startsWith('{'))
const keys = (process.argv[2] ?? 'unequal,settledUnequal,backInTime').split(',')
for (const l of lines) { const o = JSON.parse(l); const t = o.stats ?? o; console.log(o.claim, o.mutate ?? '-', 'failed', o.failedSeeds, JSON.stringify(o.failKinds ?? {}).slice(0, 160), '|', keys.map((k) => k + '=' + t[k]).join(' ')) }
