// Runs etcd raft's datadriven files, unchanged, against the TS port.
// Usage: node test/run_datadriven.ts <path to etcd raft checkout> [--json out.json] [--diff]
// Exit code 0 when every file passes byte for byte.
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTest, readTestData, type FileResult } from '../rafttest/datadriven.ts'
import { InteractionEnv } from '../rafttest/interaction_env.ts'
import { quorumHandle } from '../rafttest/quorum_dd.ts'
import { newConfChangeHandler } from '../rafttest/confchange_dd.ts'

const root = process.argv[2]
if (!root) {
  console.error('usage: node test/run_datadriven.ts <etcd raft checkout> [--json out.json] [--diff]')
  process.exit(2)
}
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const showDiff = process.argv.includes('--diff')

type Suite = { name: string; dir: string; make: () => (d: import('../rafttest/datadriven.ts').TestData) => string }
const suites: Suite[] = [
  { name: 'interaction', dir: join(root, 'testdata'), make: () => { const env = new InteractionEnv(); return d => env.Handle(d) } },
  { name: 'quorum', dir: join(root, 'quorum', 'testdata'), make: () => quorumHandle },
  { name: 'confchange', dir: join(root, 'confchange', 'testdata'), make: newConfChangeHandler },
]

const all: (FileResult & { suite: string; total: number; ms: number })[] = []
for (const s of suites) {
  for (const f of readdirSync(s.dir).filter(x => x.endsWith('.txt')).sort()) {
    const path = join(s.dir, f)
    const total = [...readTestData(path, f)].length
    const t0 = performance.now()
    const r = runTest(path, `${s.name}/${f}`, s.make())
    const ms = performance.now() - t0
    all.push({ ...r, suite: s.name, total, ms })
    const mark = r.ok ? 'PASS' : 'FAIL'
    console.log(`${mark} ${s.name}/${f}  directives ${r.passed}/${total}  ${ms.toFixed(1)} ms`)
    if (!r.ok && showDiff && r.failure) {
      console.log(`  at ${r.failure.pos} (${r.failure.cmd})`)
      if (r.failure.error) console.log('  error: ' + r.failure.error.split('\n').slice(0, 6).join('\n  '))
      const e = r.failure.expected.split('\n')
      const a = r.failure.actual.split('\n')
      for (let i = 0; i < Math.max(e.length, a.length); i++) {
        if (e[i] !== a[i]) {
          console.log(`  first differing line ${i + 1}:\n    expected: ${JSON.stringify(e[i])}\n    actual:   ${JSON.stringify(a[i])}`)
          break
        }
      }
    }
  }
}
const pass = all.filter(r => r.ok).length
const dirs = all.reduce((n, r) => n + r.total, 0)
const dirsPassed = all.reduce((n, r) => n + r.passed, 0)
for (const name of ['interaction', 'quorum', 'confchange']) {
  const s = all.filter(r => r.suite === name)
  console.log(`suite ${name}: ${s.filter(r => r.ok).length}/${s.length} files pass`)
}
console.log(`TOTAL: ${pass}/${all.length} files pass byte for byte; ${dirsPassed}/${dirs} directives matched before the first mismatch`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all.map(r => ({ suite: r.suite, file: r.file, ok: r.ok, passed: r.passed, total: r.total, failure: r.failure ? { pos: r.failure.pos, cmd: r.failure.cmd } : undefined })), null, 1))
process.exit(pass === all.length ? 0 : 1)
