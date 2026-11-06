// Runs the Go-filled fuzz scripts against the TS port, with the election-timeout
// randomness pinned to 0 on both sides. A script the Go reference panicked on was
// cut before the panicking directive; we also check the TS port throws there too.
// Usage: node diff/run_ts.ts <dir with Go outputs> <dir with the original scripts>
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTest, readTestData } from '../port/rafttest/datadriven.ts'
import { InteractionEnv } from '../port/rafttest/interaction_env.ts'
import { globalRand } from '../port/src/raft.ts'
import { RawNode } from '../port/src/rawnode.ts'
import type { TestData } from '../port/rafttest/datadriven.ts'

// read-index and restart are not etcd harness commands; the Go driver adds them, and so does this replay.
function handle(env: InteractionEnv, d: TestData): string {
  if (d.Cmd === 'read-index') {
    env.Nodes[Number(d.CmdArgs[0].Key) - 1].RawNode.ReadIndex(new TextEncoder().encode(d.CmdArgs[1].Key))
    return 'ok'
  }
  if (d.Cmd === 'restart') {
    const n = env.Nodes[Number(d.CmdArgs[0].Key) - 1]
    env.Output.Reset()
    const cfg = n.Config.clone()
    cfg.Applied = n.History[n.History.length - 1].Metadata?.GetIndex() ?? 0
    n.RawNode = new RawNode(cfg)
    n.AppendWork = []
    n.ApplyWork = []
    return env.Output.Len() === 0 ? 'ok' : env.Output.String()
  }
  return env.Handle(d)
}

globalRand.Intn = () => 0
const [outDir, inDir] = process.argv.slice(2)
let pass = 0, fail = 0, dirs = 0, panics = 0, panicsMatched = 0
for (const f of readdirSync(outDir).filter(x => x.endsWith('.txt')).sort()) {
  const env = new InteractionEnv()
  const r = runTest(join(outDir, f), f, d => handle(env, d))
  dirs += r.passed
  if (r.ok) pass++
  else {
    fail++
    console.log(`FAIL ${f} at ${r.failure!.pos} (${r.failure!.cmd})`)
    const e = r.failure!.expected.split('\n'), a = r.failure!.actual.split('\n')
    if (r.failure!.error) console.log('  error: ' + r.failure!.error.split('\n').slice(0, 4).join(' | '))
    for (let i = 0; i < Math.max(e.length, a.length); i++) if (e[i] !== a[i]) { console.log(`  line ${i + 1}\n    go: ${JSON.stringify(e[i])}\n    ts: ${JSON.stringify(a[i])}`); break }
  }
  if (existsSync(join(outDir, f + '.panic'))) {
    panics++
    // Replay the original script on a fresh env and see whether the TS port throws at the same directive.
    const note = readFileSync(join(outDir, f + '.panic'), 'utf8').trim()
    const k = Number(/directive (\d+)/.exec(note)![1])
    const env2 = new InteractionEnv()
    let i = 0, threwAt = -1
    for (const d of readTestData(join(inDir, f), f)) {
      try { handle(env2, d) } catch { threwAt = i; break }
      i++
    }
    if (threwAt === k) panicsMatched++
    else console.log(`PANIC MISMATCH ${f}: go panicked at directive ${k}, ts threw at ${threwAt} (${note})`)
  }
}
console.log(`fuzz: ${pass}/${pass + fail} scripts match the Go reference byte for byte; ${dirs} directives compared; Go panicked in ${panics} scripts, TS threw at the same directive in ${panicsMatched}`)
process.exit(fail === 0 && panics === panicsMatched ? 0 : 1)
