// The switch-off pass. For each marked rule it runs the tests with that one rule switched off
// and records which tests go red. Plain node 22, nothing installed.
//
//   node probes/p6/pass.mjs run <suite.json> --out <results.jsonl> [--jobs N] [--ids a,b] [--tests <regex>]
//   node probes/p6/pass.mjs report <results.jsonl> [<results.jsonl> ...] [--rules probes/p6/rules.json] [--md]
//
// A suite file names the marked sources and the tests:
//   { "name": "raft",
//     "scan": ["${MARKED}/crates"],                        where tools/rule-scan.mjs finds the markers
//     "tests": [ { "name": "files", "group": "files", "cwd": "${MARKED}", "cmd": ["..."], "timeout_ms": 20000 } ] }
// `${NAME}` is filled in from the environment. Tests run in the order given: put the cheap ones first.
//
// How a rule is switched off: the test process gets RULE_OFF=<id>. The Rust marker (crates/rule,
// feature switch-env) and the TypeScript one (rule-env.ts) read it. RULE_HIT_FILE names a file the
// marker makes when the switched-off rule is reached, so "no test reaches this rule" can be told
// from "tests reach it and stay green".
//
// A test is red when it exits with an error. A test that runs past its timeout is killed, with
// its whole process group, and counted as caught by timeout. First every test is run with no rule
// off: all must be green, or the pass stops.
//
// Times: wall time per test, and CPU time of the child processes (user plus system, read from
// /proc, Linux only; per test only with --jobs 1, in total always).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { scan } from '../../tools/rule-scan.mjs'

const args = process.argv.slice(2)
const mode = args[0]
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const fill = s => s.replace(/\$\{(\w+)\}/g, (_, k) => {
  if (process.env[k] === undefined) { console.log(`FAILED pass: the suite needs ${k} in the environment`); process.exit(1) }
  return process.env[k]
})

// CPU seconds used so far by child processes that have ended (Linux: /proc/self/stat, fields 16 and 17).
function childCpu() {
  try {
    const s = fs.readFileSync('/proc/self/stat', 'utf8')
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return (Number(f[13]) + Number(f[14])) / 100
  } catch { return NaN }
}

// Names of what failed, as the test tools print them.
function items(out) {
  const found = new Set()
  // `FAIL <name> ...` names one failing file, script or check; `FAIL <tool>: ...` is a summary line.
  for (const m of out.matchAll(/^FAIL ([^\s:]+)(?!:)\s/gm)) found.add(m[1])
  for (const m of out.matchAll(/^test (\S+) \.\.\. FAILED/gm)) found.add(m[1])
  return [...found]
}

function runOne(test, id, hitFile) {
  return new Promise(resolve => {
    const env = { ...process.env, ...(test.env ?? {}) }
    delete env.RULE_OFF; delete env.RULE_HIT_FILE
    if (id) { env.RULE_OFF = id; env.RULE_HIT_FILE = hitFile }
    const t0 = process.hrtime.bigint()
    const child = spawn(test.cmd[0], test.cmd.slice(1), { cwd: test.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', timedOut = false
    const take = d => { if (out.length < 4_000_000) out += d }
    child.stdout.on('data', take); child.stderr.on('data', take)
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, test.timeout_ms)
    child.on('error', e => { clearTimeout(timer); resolve({ result: 'red', wall_ms: 0, items: ['spawn: ' + e.message], hit: false }) })
    child.on('close', code => {
      clearTimeout(timer)
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      const wall_ms = Number(process.hrtime.bigint() - t0) / 1e6
      let hit = false
      if (id) { hit = fs.existsSync(hitFile); if (hit) fs.rmSync(hitFile) }
      const result = timedOut ? 'timeout' : code === 0 ? 'green' : 'red'
      const all = result === 'red' ? items(out) : []
      resolve({ result, wall_ms: Math.round(wall_ms * 10) / 10, items: all.slice(0, 6), failed: all.length, hit })
    })
  })
}

async function run() {
  const suite = JSON.parse(fill(fs.readFileSync(args[1], 'utf8')))
  const out = opt('--out')
  if (!out) { console.log('FAILED pass: give --out <results.jsonl>'); process.exit(1) }
  const jobs = Number(opt('--jobs') ?? 1)
  const only = opt('--ids')?.split(',')
  const testRe = opt('--tests') ? new RegExp(opt('--tests')) : null
  const tests = suite.tests.filter(t => !testRe || testRe.test(t.name))
  let ids = [...new Set(scan(suite.scan).map(s => s.id).filter(id => !id.startsWith('test.')))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (only) ids = ids.filter(id => only.includes(id))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-pass-'))
  fs.writeFileSync(out, '')
  const put = o => fs.appendFileSync(out, JSON.stringify(o) + '\n')
  const load = () => os.loadavg()[0].toFixed(2)
  put({ kind: 'head', suite: suite.name, ids: ids.length, tests: tests.map(t => ({ name: t.name, group: t.group ?? t.name, timeout_ms: t.timeout_ms })), jobs, cores: os.cpus().length, node: process.version, load: load(), at: new Date().toISOString() })

  // The baseline: no rule off. Every test must be green.
  const baseT0 = Date.now(), baseC0 = childCpu()
  for (const t of tests) {
    const c0 = childCpu()
    const r = await runOne(t, null, null)
    put({ kind: 'base', test: t.name, ...r, cpu_ms: Math.round((childCpu() - c0) * 1000) })
    if (r.result !== 'green') { console.log(`FAILED pass: with no rule off, ${t.name} is ${r.result} (${r.items.join(', ')})`); process.exit(1) }
  }
  put({ kind: 'base-total', wall_ms: Date.now() - baseT0, cpu_ms: Math.round((childCpu() - baseC0) * 1000) })

  const t0 = Date.now(), c0 = childCpu()
  let next = 0, done = 0
  const worker = async w => {
    for (;;) {
      const i = next++
      if (i >= ids.length) return
      const id = ids[i]
      for (const t of tests) {
        const cc = childCpu()
        const r = await runOne(t, id, path.join(tmp, `hit-${w}`))
        put({ kind: 'run', id, test: t.name, group: t.group ?? t.name, ...r, ...(jobs === 1 ? { cpu_ms: Math.round((childCpu() - cc) * 1000) } : {}) })
      }
      done++
      if (process.stderr.isTTY || done % 10 === 0) process.stderr.write(`  ${done} of ${ids.length} rules\n`)
    }
  }
  await Promise.all(Array.from({ length: jobs }, (_, w) => worker(w)))
  const total = { kind: 'total', wall_ms: Date.now() - t0, cpu_ms: Math.round((childCpu() - c0) * 1000), jobs, load_end: load(), at: new Date().toISOString() }
  put(total)
  fs.rmSync(tmp, { recursive: true, force: true })
  report([out], false)
}

function read(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { head: rows.find(r => r.kind === 'head'), base: rows.filter(r => r.kind === 'base'), baseTotal: rows.find(r => r.kind === 'base-total'), runs: rows.filter(r => r.kind === 'run'), total: rows.find(r => r.kind === 'total') }
}

function report(files, md) {
  const rulesFile = opt('--rules')
  const rules = rulesFile ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : null
  for (const file of files) {
    const { head, base, baseTotal, runs, total } = read(file)
    const ids = [...new Set(runs.map(r => r.id))]
    const groups = [...new Set(head.tests.map(t => t.group))]
    const by = id => runs.filter(r => r.id === id)
    const caught = r => r.result !== 'green'
    const proven = ids.filter(id => by(id).some(caught))
    const unproven = ids.filter(id => !by(id).some(caught))
    const unreached = unproven.filter(id => !by(id).some(r => r.hit))
    const timeouts = runs.filter(r => r.result === 'timeout')
    const sec = ms => (ms / 1000).toFixed(2)
    console.log(`pass: suite ${head.suite}, ${ids.length} rules, ${head.tests.length} tests, ${head.jobs} job${head.jobs === 1 ? '' : 's'} on ${head.cores} cores, load ${head.load} at the start`)
    console.log(`  baseline (no rule off): wall ${sec(baseTotal.wall_ms)} s, CPU ${sec(baseTotal.cpu_ms)} s; ${base.map(b => `${b.test} ${sec(b.wall_ms)}`).join(', ')}`)
    console.log(`  the pass: wall ${sec(total.wall_ms)} s, CPU ${sec(total.cpu_ms)} s; per rule: wall ${sec(total.wall_ms / ids.length)} s, CPU ${sec(total.cpu_ms / ids.length)} s`)
    // What each group of tests costs per rule, and what it proves alone and with the groups before it.
    let before = new Set()
    for (const g of groups) {
      const rs = runs.filter(r => r.group === g)
      const wall = rs.reduce((a, r) => a + r.wall_ms, 0)
      const cpu = rs.every(r => r.cpu_ms !== undefined) ? rs.reduce((a, r) => a + r.cpu_ms, 0) : NaN
      const alone = new Set(rs.filter(caught).map(r => r.id))
      const withBefore = new Set([...before, ...alone])
      console.log(`  group ${g}: per rule wall ${sec(wall / ids.length)} s${Number.isNaN(cpu) ? '' : `, CPU ${sec(cpu / ids.length)} s`}; catches ${alone.size} rules alone, ${withBefore.size} with the groups before it`)
      before = withBefore
    }
    // The cost if a rule's run stops at its first red test, and if only tests that reach the rule run.
    let stopFirst = 0, reachOnly = 0
    for (const id of ids) {
      let stopped = false
      for (const r of by(id)) {
        if (!stopped) stopFirst += r.wall_ms
        if (caught(r)) stopped = true
        if (r.hit || caught(r)) reachOnly += r.wall_ms
      }
    }
    console.log(`  summed test time per rule: all tests ${sec(runs.reduce((a, r) => a + r.wall_ms, 0) / ids.length)} s; stopping at the first red ${sec(stopFirst / ids.length)} s; only tests that reach the rule ${sec(reachOnly / ids.length)} s`)
    console.log(`  proven (some test goes red): ${proven.length} of ${ids.length}; unproven: ${unproven.length}${unproven.length ? ` (${unproven.join(', ')})` : ''}`)
    console.log(`  unproven and never reached by a test: ${unreached.length}${unreached.length ? ` (${unreached.join(', ')})` : ''}`)
    console.log(`  runs cut by the timeout: ${timeouts.length}${timeouts.length ? ` (${[...new Set(timeouts.map(r => r.id))].join(', ')})` : ''}`)
    if (md) {
      console.log(`\n| Rule | Kind | Why | Tests that go red |\n|---|---|---|---|`)
      const all = rules ? Object.keys(rules).filter(id => rules[id].suite === head.suite) : ids
      for (const id of all) {
        const rs = by(id)
        let red = '(not run: no marker)'
        if (rs.length) {
          const c = rs.filter(caught)
          const short = r => `${r.test.replace(/^(test-|scripts-|core\/|patterns\/)/, '')}${r.result === 'timeout' ? ' (cut by the timeout)' : r.failed > 1 ? ` (${r.failed})` : ''}`
          const parts = groups.map(g => [g, c.filter(r => r.group === g)]).filter(([, x]) => x.length).map(([g, x]) => `${g}: ${x.map(short).join(', ')}`)
          red = c.length ? parts.join('; ') : rs.some(r => r.hit) ? '**unproven**: reached, every test green' : '**unproven**: no test reaches it'
        }
        console.log(`| \`${id}\` | ${rules?.[id]?.kind ?? ''} | ${rules?.[id]?.why ?? ''} | ${red} |`)
      }
    }
    console.log(`ok pass: ${head.suite}: ${proven.length} of ${ids.length} rules proven, ${unproven.length} unproven`)
  }
}

if (mode === 'run') await run()
else if (mode === 'report') report(args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--rules'), args.includes('--md'))
else { console.log('usage: pass.mjs run <suite.json> --out <results.jsonl> [--jobs N] [--ids a,b] [--tests <regex>]\n       pass.mjs report <results.jsonl> ... [--rules rules.json] [--md]'); process.exit(2) }
