// Mutation run on the TS port: how strong is etcd's datadriven oracle (and the
// Go-filled fuzz corpus) at catching a one-rule change in the ported core?
// Mutants are made mechanically, as REQUIREMENTS DEV-10 (d) says, adapted to code:
//   rel   each < <= > >= flipped to its partner (< to <=, <= to <, > to >=, >= to >)
//   guard each if-condition conjunct dropped (a single condition becomes `true`)
//   drop  each single-line state update deleted
//   swap  each pair of adjacent single-line updates swapped
//   eq    each === / !== flipped (an extra operator, reported apart)
// Usage: node diff/mutate.ts <etcd raft checkout> <fuzz out dir> <fuzz in dir> [files...]
//        node diff/mutate.ts --count
// With E10_SURVIVORS=<an earlier mutation-run.txt>, only that run's survivors are re-run
// (against the given fuzz corpus; they already passed the datadriven files).
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
const [etcdRoot, fuzzOut, fuzzIn, ...only] = process.argv.slice(2)
const SP = process.env.SP ?? '/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad'
const WORK = join(SP, 'e10mut')
const files = only.length ? only : ['raft.ts', 'log.ts', 'log_unstable.ts', 'tracker.ts', 'quorum.ts', 'confchange.ts', 'rawnode.ts', 'storage.ts', 'read_only.ts']

type Mutant = { file: string; line: number; op: string; text: string }

const updateRe = /^\s*(?!const |let |return |throw |if |for |while |case |default|switch )[\w.!\[\]()]+(\s*(=|\+=|-=)\s*(?!=)|\+\+|--)/
function isUpdate(l: string): boolean {
  const t = l.trim()
  if (!updateRe.test(l)) return false
  if (t.endsWith('{') || t.endsWith('(') || t.endsWith(',') || t.startsWith('//')) return false
  return (t.match(/\(/g)?.length ?? 0) === (t.match(/\)/g)?.length ?? 0)
}

function mutantsOf(file: string, src: string): Mutant[] {
  const lines = src.split('\n')
  const out: Mutant[] = []
  const add = (line: number, op: string, newLine: string) => {
    const copy = lines.slice()
    copy[line] = newLine
    out.push({ file, line: line + 1, op, text: copy.join('\n') })
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const t = l.trim()
    if (t.startsWith('//') || t.startsWith('import') || t.startsWith('export type') || t.startsWith('type ') || t === '') continue
    // rel
    for (const [from, to] of [[' < ', ' <= '], [' <= ', ' < '], [' > ', ' >= '], [' >= ', ' > ']]) {
      let k = l.indexOf(from)
      while (k >= 0) {
        add(i, 'rel', l.slice(0, k) + to + l.slice(k + from.length))
        k = l.indexOf(from, k + 1)
      }
    }
    // eq
    for (const [from, to] of [[' === ', ' !== '], [' !== ', ' === ']]) {
      let k = l.indexOf(from)
      while (k >= 0) {
        add(i, 'eq', l.slice(0, k) + to + l.slice(k + from.length))
        k = l.indexOf(from, k + 1)
      }
    }
    // guard
    const gi = l.indexOf('if (')
    if (gi >= 0) {
      let depth = 0
      let end = -1
      for (let k = gi + 3; k < l.length; k++) {
        if (l[k] === '(') depth++
        else if (l[k] === ')') {
          depth--
          if (depth === 0) { end = k; break }
        }
      }
      if (end > 0) {
        const cond = l.slice(gi + 4, end)
        const parts: string[] = []
        let d = 0, last = 0
        for (let k = 0; k < cond.length; k++) {
          if (cond[k] === '(') d++
          else if (cond[k] === ')') d--
          else if (d === 0 && cond.startsWith(' && ', k)) { parts.push(cond.slice(last, k)); last = k + 4; k += 3 }
        }
        parts.push(cond.slice(last))
        if (parts.length === 1) add(i, 'guard', l.slice(0, gi + 4) + 'true' + l.slice(end))
        else for (let p = 0; p < parts.length; p++) {
          const rest = parts.filter((_, q) => q !== p).join(' && ')
          add(i, 'guard', l.slice(0, gi + 4) + rest + l.slice(end))
        }
      }
    }
    // drop
    if (isUpdate(l)) add(i, 'drop', l.replace(/\S.*$/, '/* dropped */'))
    // swap
    if (isUpdate(l) && i + 1 < lines.length && isUpdate(lines[i + 1])) {
      const copy = lines.slice()
      ;[copy[i], copy[i + 1]] = [copy[i + 1], copy[i]]
      out.push({ file, line: i + 1, op: 'swap', text: copy.join('\n') })
    }
  }
  return out
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(124) }, timeoutMs)
    p.on('exit', code => { clearTimeout(t); resolve(code ?? 1) })
  })
}

async function main() {
  const all: Mutant[] = []
  for (const f of files) all.push(...mutantsOf(f, readFileSync(join(HERE, 'port', 'src', f), 'utf8')))
  if (etcdRoot === '--count') {
    for (const op of ['rel', 'guard', 'drop', 'swap', 'eq']) console.log(op, all.filter(m => m.op === op).length)
    console.log('total', all.length)
    return
  }
  let todo = all
  const survFile = process.env.E10_SURVIVORS
  if (survFile) {
    const keys = new Set(readFileSync(survFile, 'utf8').split('\n').filter(l => /^  \S+\.ts:\d+ \w+: /.test(l)).map(l => l.trim()))
    todo = all.filter(m => keys.has(`${m.file}:${m.line} ${m.op}: ${m.text.split('\n')[m.line - 1].trim().slice(0, 140)}`))
    console.log(`re-running ${todo.length} survivors of ${survFile} (of ${keys.size} listed)`)
  }
  rmSync(WORK, { recursive: true, force: true })
  const W = 2
  for (let w = 0; w < W; w++) {
    mkdirSync(join(WORK, `w${w}`), { recursive: true })
    cpSync(join(HERE, 'port'), join(WORK, `w${w}`, 'port'), { recursive: true })
    cpSync(join(HERE, 'diff'), join(WORK, `w${w}`, 'diff'), { recursive: true })
  }
  const results: { m: Mutant; by: string }[] = []
  let next = 0
  async function worker(w: number) {
    const dir = join(WORK, `w${w}`)
    while (next < todo.length) {
      const m = todo[next++]
      const target = join(dir, 'port', 'src', m.file)
      const orig = readFileSync(join(HERE, 'port', 'src', m.file), 'utf8')
      writeFileSync(target, m.text)
      let by = 'survived'
      const c1 = survFile ? 0 : await run('node', [join(dir, 'port', 'test', 'run_datadriven.ts'), etcdRoot], 20000)
      if (c1 !== 0) by = c1 === 124 ? 'datadriven-timeout' : 'datadriven'
      else {
        const c2 = await run('node', [join(dir, 'diff', 'run_ts.ts'), fuzzOut, fuzzIn], 60000)
        if (c2 !== 0) by = c2 === 124 ? 'fuzz-timeout' : 'fuzz'
      }
      writeFileSync(target, orig)
      results.push({ m, by })
    }
  }
  await Promise.all(Array.from({ length: W }, (_, w) => worker(w)))
  results.sort((a, b) => (a.m.file + a.m.line + a.m.op).localeCompare(b.m.file + b.m.line + b.m.op))
  const rows: Record<string, Record<string, number>> = {}
  for (const r of results) {
    const key = `${r.m.file} ${r.m.op}`
    rows[key] ??= { total: 0, datadriven: 0, fuzz: 0, survived: 0 }
    rows[key].total++
    rows[key][r.by.startsWith('datadriven') ? 'datadriven' : r.by.startsWith('fuzz') ? 'fuzz' : 'survived']++
  }
  console.log('file op: total, killed by datadriven, killed only by fuzz, survived')
  for (const [k, v] of Object.entries(rows)) console.log(`${k}: ${v.total}, ${v.datadriven}, ${v.fuzz}, ${v.survived}`)
  for (const op of ['rel', 'guard', 'drop', 'swap', 'eq', 'ALL']) {
    const s = results.filter(r => op === 'ALL' || r.m.op === op)
    const dd = s.filter(r => r.by.startsWith('datadriven')).length
    const fz = s.filter(r => r.by.startsWith('fuzz')).length
    console.log(`op ${op}: ${s.length} mutants; datadriven kills ${dd} (${(100 * dd / s.length).toFixed(1)}%); with fuzz ${dd + fz} (${(100 * (dd + fz) / s.length).toFixed(1)}%)`)
  }
  console.log('\nsurvivors:')
  for (const r of results.filter(r => r.by === 'survived')) {
    const line = r.m.text.split('\n')[r.m.line - 1].trim()
    console.log(`  ${r.m.file}:${r.m.line} ${r.m.op}: ${line.slice(0, 140)}`)
  }
}
main()
