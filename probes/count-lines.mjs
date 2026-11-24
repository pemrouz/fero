#!/usr/bin/env node
// Counts code lines of the Rust Raft port, of etcd raft's Go source and of the
// TypeScript port, part by part, for the probe sheet (README.md, P1).
//
// A code line is a line that is neither blank nor a comment. Comments are
// `//` lines and `/* ... */` blocks. The scan does not parse strings, so a
// `//` inside a string at the start of a line would be miscounted; there is
// none that matters in these trees.
//
// Run from the repo root:
//   node probes/count-lines.mjs <etcd raft checkout> [<the TypeScript port dir>]
// The TypeScript port is the experiment's `port/` folder on the design branch.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [goDir, tsDir] = process.argv.slice(2)
if (!goDir) {
  console.error('usage: node probes/count-lines.mjs <etcd raft checkout> [<TypeScript port dir>]')
  process.exit(2)
}

function codeLines(file) {
  let n = 0
  let inBlock = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    let line = raw.trim()
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      inBlock = false
      line = line.slice(end + 2).trim()
    }
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2)
      if (end < 0) { inBlock = true; line = ''; break }
      line = line.slice(end + 2).trim()
    }
    if (line === '' || line.startsWith('//')) continue
    n++
  }
  return n
}

function files(dir, ext, deep = false) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (deep) out.push(...files(p, ext, true)) }
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

const sum = (list) => list.reduce((n, f) => n + codeLines(f), 0)
const not = (...names) => (f) => !names.includes(basename(f))
const only = (...names) => (f) => names.includes(basename(f))
const isTest = (f) => f.endsWith('_test.go')

// --- Go ---------------------------------------------------------------
const goCore = files(goDir, '.go').filter((f) => !isTest(f))
const goLeftOut = only('doc.go', 'state_trace.go', 'state_trace_nop.go')
const goSub = (d) => files(join(goDir, d), '.go').filter((f) => !isTest(f))
const goTests = files(goDir, '.go', true).filter(isTest)
const goDrivers = only('interaction_test.go', 'datadriven_test.go')
const go = {
  core: sum(goCore.filter((f) => !goLeftOut(f) && basename(f) !== 'node.go')),
  node: sum(goCore.filter(only('node.go'))),
  leftOut: sum(goCore.filter(goLeftOut)),
  quorum: sum(goSub('quorum')),
  tracker: sum(goSub('tracker')),
  confchange: sum(goSub('confchange')),
  raftpb: sum(goSub('raftpb').filter(not('raft.pb.go'))),
  generated: sum(goSub('raftpb').filter(only('raft.pb.go'))),
  rafttest: sum(goSub('rafttest').filter(not('network.go', 'node.go'))),
  rafttestLeftOut: sum(goSub('rafttest').filter(only('network.go', 'node.go'))),
  drivers: sum(goTests.filter(goDrivers)),
  unitTests: sum(goTests.filter((f) => !goDrivers(f))),
}

// --- Rust -------------------------------------------------------------
const rs = join(root, 'crates/raft/src')
const rsCore = files(rs, '.rs')
const rsOwn = only('num.rs', 'gostd.rs', 'lib.rs')
const hs = join(root, 'crates/raft-harness')
const rust = {
  core: sum(rsCore.filter((f) => !rsOwn(f) && !only('node.rs', 'log_test.rs')(f))),
  node: sum(rsCore.filter(only('node.rs'))),
  own: sum(rsCore.filter(rsOwn)),
  quorum: sum(files(join(rs, 'quorum'), '.rs')),
  tracker: sum(files(join(rs, 'tracker'), '.rs')),
  confchange: sum(files(join(rs, 'confchange'), '.rs')),
  raftpb: sum(files(join(rs, 'raftpb'), '.rs')),
  rafttest: sum(files(join(hs, 'src/rafttest'), '.rs')),
  drivers: sum(files(join(hs, 'src'), '.rs').filter(not('diff.rs')))
    + sum([join(hs, 'src/bin/raft-datadriven.rs')]),
  diff: sum([join(hs, 'src/diff.rs'), join(hs, 'src/bin/raft-diff.rs')]),
  tests: sum(files(join(hs, 'tests'), '.rs')) + sum(rsCore.filter(only('log_test.rs'))),
}

// --- TypeScript -------------------------------------------------------
let ts = null
if (tsDir) {
  const src = files(join(tsDir, 'src'), '.ts')
  const parts = only('quorum.ts', 'tracker.ts', 'confchange.ts', 'raftpb.ts')
  const own = only('gofmt.ts', 'index.ts')
  ts = {
    core: sum(src.filter((f) => !parts(f) && !own(f) && basename(f) !== 'node.ts')),
    node: sum(src.filter(only('node.ts'))),
    own: sum(src.filter(own)),
    quorum: sum(src.filter(only('quorum.ts'))),
    tracker: sum(src.filter(only('tracker.ts'))),
    confchange: sum(src.filter(only('confchange.ts'))),
    raftpb: sum(src.filter(only('raftpb.ts'))),
    rafttest: sum(files(join(tsDir, 'rafttest'), '.ts').filter(only('interaction_env.ts'))),
    drivers: sum(files(join(tsDir, 'rafttest'), '.ts').filter(not('interaction_env.ts')))
      + sum(files(join(tsDir, 'test'), '.ts')),
  }
}

const lib = (x) => x.core + x.node + (x.own ?? 0) + x.quorum + x.tracker + x.confchange + x.raftpb
const rows = [
  ['core package, without node and the helpers below', 'core'],
  ['node (Go: all of node.go; the ports: the types the core needs)', 'node'],
  ['quorum', 'quorum'],
  ['tracker', 'tracker'],
  ['confchange', 'confchange'],
  ['raftpb, hand written', 'raftpb'],
  ["helpers Go gets from its standard library (num, gostd, lib / gofmt, index)", 'own'],
  ['LIBRARY TOTAL', null],
  ['rafttest (InteractionEnv and its handlers)', 'rafttest'],
  ['test drivers and the datadriven reader', 'drivers'],
]
const cell = (x, key) => (x == null ? '-' : key == null ? lib(x) : x[key] ?? '-')
console.log(['part', 'go', 'rust', 'typescript'].join('\t'))
for (const [label, key] of rows) console.log([label, cell(go, key), cell(rust, key), cell(ts, key)].join('\t'))
console.log(`go, left out of both ports: doc.go and state_trace*.go ${go.leftOut}, generated raft.pb.go ${go.generated}, rafttest network.go and node.go ${go.rafttestLeftOut}, unit tests ${go.unitTests}`)
console.log(`rust, beside the port: diff fuzz ${rust.diff}, tests ${rust.tests}`)
