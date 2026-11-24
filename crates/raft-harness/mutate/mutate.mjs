// Licensed under the Apache License, Version 2.0.
//
// Mutation run on the Rust port of etcd raft: how many one-rule changes of the
// core do etcd's 41 datadriven files catch, and how many more do the Go-filled
// fuzz corpora catch?
//
// A mutant is the core with one rule changed. The operators are mechanical:
//   rel    each < <= > >= flipped to its partner (< to <=, <= to <, > to >=, >= to >)
//   guard  each `if` conjunct dropped (a single condition becomes `true`); match guards count
//   drop   each single-line state update deleted (`x = ..;`, `x += ..;`, `x -= ..;`)
//   swap   each pair of adjacent single-line updates swapped
//   eq     each == / != flipped (an extra operator, reported apart)
//
// Method: one build per mutant, on a scratch copy of the workspace, with cargo's
// incremental build. The real tree is only read. A mutant that does not compile
// is counted apart ("nobuild"): it is not a program, so no test can run on it.
//
// Usage (plain Node 22, nothing installed):
//   node mutate.mjs count                      # how many mutants per operator and file
//   node mutate.mjs list                       # one line per mutant
//   node mutate.mjs run                        # build and test every mutant
//   node mutate.mjs report                     # tables from the results file
//   node mutate.mjs swaps                      # split surviving swaps: independent or not
//   node mutate.mjs sample <n> <seed>          # a seeded random sample of the other survivors
//
// Environment:
//   WORK    scratch directory (copies, build output, results). Default ./target/work/raft-mutate.
//   CORPUS  directory with seed2/, seed5/, seed7/ (each with in/ and out/), made by
//           diff/run_diff.sh corpus. Without it, survivors of the 41 files are not run further.
//   JOBS    workers, each with its own copy and build directory. Default 2.
//   HEAVY   optional command put in front of each build and test (for example a lock wrapper).
//   SAMPLE, SAMPLE_SEED  run only a seeded random sample of SAMPLE mutants.
//   ONLY    run only mutants whose key starts with this text (for a quick check).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const SRC = join('crates', 'raft', 'src')
const WORK = resolve(process.env.WORK ?? './target/work/raft-mutate')
const RESULTS = join(WORK, 'results.jsonl')
const OPS = ['rel', 'guard', 'drop', 'swap', 'eq']
const SEEDS = ['seed2', 'seed5', 'seed7']

// The Rust counterparts of the nine core files of the TypeScript experiment.
const FILES = [
  'raft.rs', 'log.rs', 'log_unstable.rs', 'rawnode.rs', 'storage.rs', 'read_only.rs',
  'tracker/inflights.rs', 'tracker/progress.rs', 'tracker/state.rs', 'tracker/tracker.rs',
  'quorum/joint.rs', 'quorum/majority.rs', 'quorum/quorum.rs', 'quorum/voteresult_string.rs',
  'confchange/confchange.rs', 'confchange/restore.rs',
]

// ---- reading Rust ---------------------------------------------------------

// Blank out comments, strings and char literals (same length, newlines kept),
// so that an operator inside a message or a comment is never mutated.
export function mask(src) {
  const out = src.split('')
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length
      blank(i, j); i = j
    } else if (c === '/' && d === '*') {
      let depth = 1, j = i + 2
      while (j < src.length && depth > 0) {
        if (src.startsWith('/*', j)) { depth++; j += 2 } else if (src.startsWith('*/', j)) { depth--; j += 2 } else j++
      }
      blank(i, j); i = j
    } else if (c === 'r' && /^r#*"/.test(src.slice(i, i + 8)) && !/\w/.test(src[i - 1] ?? ' ')) {
      const hashes = /^r(#*)"/.exec(src.slice(i, i + 8))[1]
      let j = src.indexOf('"' + hashes, i + 2 + hashes.length); j = j < 0 ? src.length : j + 1 + hashes.length
      blank(i, j); i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j); i = j + 1
    } else if (c === "'") {
      // A char literal ('x', '\n', '\u{1F}') or a lifetime ('a).
      const m = /^'(\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12))
      if (m) { blank(i + 1, i + m[0].length - 1); i += m[0].length } else i++
    } else i++
  }
  return out.join('')
}

const UPDATE = /^(?!(?:let|return|if|for|while|match|const|static|pub|use|type|fn|else|break|continue|loop|impl|mod)\b)([\w.\[\]()*&]+?)\s*(\+=|-=|=)\s(?!=)/
function balanced(t) {
  let d = 0
  for (const ch of t) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d-- }
  return d === 0
}
// A single-line state update: `target = value;`, `target += value;`, `target -= value;`.
function isUpdate(maskedLine) {
  const t = maskedLine.trim()
  return UPDATE.test(t) && t.endsWith(';') && balanced(t)
}

// All mutants of one file. Each is { key, file, line, col, op, text, after }.
export function mutantsOf(file, src) {
  const m = mask(src)
  const starts = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1)
  const lineOf = pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1 } return lo }
  const out = []
  const add = (op, pos, edits) => {
    let text = src
    for (const [a, b, s] of edits.slice().sort((x, y) => y[0] - x[0])) text = text.slice(0, a) + s + text.slice(b)
    const line = lineOf(pos)
    out.push({ key: `${file}:${line + 1}:${pos - starts[line] + 1} ${op}`, file, line: line + 1, col: pos - starts[line] + 1, op, text })
  }

  // rel and eq: an operator with white space on both sides (so `Vec<u64>`, `->`, `=>` never match).
  const flip = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==' }
  for (const x of m.matchAll(/(?<=\s)(<=|>=|==|!=|<|>)(?=\s)/g)) {
    add(x[1] === '==' || x[1] === '!=' ? 'eq' : 'rel', x.index, [[x.index, x.index + x[1].length, flip[x[1]]]])
  }

  // guard: the condition runs from `if` to the first `{` (or `=>` for a match guard) outside brackets.
  for (const x of m.matchAll(/\bif\b/g)) {
    const from = x.index + 2
    let depth = 0, end = -1
    const cuts = []
    for (let k = from; k < m.length; k++) {
      const ch = m[k]
      if (depth === 0 && (ch === '{' || m.startsWith('=>', k))) { end = k; break }
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
      else if (depth === 0 && m.startsWith('&&', k) && /\s/.test(m[k - 1]) && /\s/.test(m[k + 2])) { cuts.push(k); k++ }
      if (depth < 0 || ch === ';') break
    }
    if (end < 0) continue
    // The parts, trimmed: [start, end) of each conjunct.
    const parts = []
    let a = from
    for (const c of [...cuts, end]) {
      let s = a, e = c
      while (s < e && /\s/.test(m[s])) s++
      while (e > s && /\s/.test(m[e - 1])) e--
      parts.push([s, e]); a = c + 2
    }
    const isLet = ([s, e]) => /^let\b/.test(m.slice(s, e))
    if (parts.length === 1) {
      if (!isLet(parts[0])) add('guard', parts[0][0], [[parts[0][0], parts[0][1], 'true']])
    } else {
      for (let p = 0; p < parts.length; p++) {
        if (isLet(parts[p])) continue // dropping a `let` conjunct drops its bindings: not a program
        if (p === 0) add('guard', parts[0][0], [[parts[0][0], parts[1][0], '']])
        else add('guard', parts[p][0], [[parts[p - 1][1], parts[p][1], '']])
      }
    }
  }

  // drop and swap, line by line.
  const ml = m.split('\n')
  for (let i = 0; i < ml.length; i++) {
    if (!isUpdate(ml[i])) continue
    const s = starts[i] + ml[i].search(/\S/), e = starts[i] + ml[i].trimEnd().length
    add('drop', s, [[s, e, '/* dropped */']])
    if (i + 1 < ml.length && isUpdate(ml[i + 1])) {
      const s2 = starts[i + 1] + ml[i + 1].search(/\S/), e2 = starts[i + 1] + ml[i + 1].trimEnd().length
      add('swap', s, [[s, e, src.slice(s2, e2)], [s2, e2, src.slice(s, e)]])
    }
  }
  for (const mu of out) {
    const lines = mu.text.split('\n')
    mu.before = src.split('\n')[mu.line - 1].trim()
    mu.after = lines[mu.line - 1].trim()
    if (mu.op === 'swap') mu.next = src.split('\n')[mu.line].trim()
  }
  return out
}

function allMutants(root) {
  const all = []
  for (const f of FILES) all.push(...mutantsOf(f, readFileSync(join(root, SRC, f), 'utf8')))
  return all
}

// A small seeded generator (mulberry32) and a shuffle, so samples can be drawn again.
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function shuffled(list, seed) {
  const r = rng(seed), a = list.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

// ---- running --------------------------------------------------------------

function run(cmd, args, opts, timeoutMs) {
  const heavy = (process.env.HEAVY ?? '').split(' ').filter(Boolean)
  return new Promise(done => {
    // Its own process group, so that a timeout kills the test and not only its wrapper.
    const p = spawn([...heavy, cmd][0], [...heavy, cmd, ...args].slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts })
    let text = ''
    p.stdout.on('data', d => { if (text.length < 20000) text += d })
    p.stderr.on('data', d => { if (text.length < 20000) text += d })
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {} done({ code: 124, text }) }, timeoutMs)
    p.on('exit', code => { clearTimeout(t); done({ code: code ?? 137, text }) })
  })
}
// A test binary runs with a memory cap, so a mutant that loops and allocates cannot take the box down.
const capped = (bin, args) => ['sh', ['-c', 'ulimit -v 4000000; exec "$0" "$@"', bin, ...args]]

async function runAll() {
  const base = join(WORK, 'base')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(join(base, 'crates'), { recursive: true })
  for (const f of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) cpSync(join(ROOT, f), join(base, f))
  for (const c of ['raft', 'raft-harness']) cpSync(join(ROOT, 'crates', c), join(base, 'crates', c), { recursive: true })
  // The copy gets a faster build profile. Overflow checks stay on, as in the release profile.
  appendFileSync(join(base, 'Cargo.toml'), '\n[profile.mut]\ninherits = "release"\nopt-level = 1\nincremental = true\ncodegen-units = 64\n')

  let todo = allMutants(base)
  const total = todo.length
  if (process.env.ONLY) todo = todo.filter(x => x.key.startsWith(process.env.ONLY))
  if (process.env.SAMPLE) todo = shuffled(todo, Number(process.env.SAMPLE_SEED ?? 1)).slice(0, Number(process.env.SAMPLE))
  const seen = new Set(existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key) : [])
  todo = todo.filter(x => !seen.has(x.key))
  console.log(`${total} mutants in all; ${seen.size} already done; ${todo.length} to run`)

  const corpus = process.env.CORPUS ? resolve(process.env.CORPUS) : null
  const env = { ...process.env, RUSTFLAGS: '--cap-lints warn' } // a lint is not a compile error here
  const jobs = Number(process.env.JOBS ?? 2)
  let next = 0, done = 0
  const t0 = Date.now()

  async function tests(dir) {
    const bin = n => join(dir, 'target', 'mut', n)
    const dd = await run(...capped(bin('raft-datadriven'), ['--testdata', join(dir, 'crates', 'raft', 'testdata')]), { cwd: dir }, 20000)
    if (dd.code !== 0) return { by: 'files', note: dd.code === 124 ? 'timeout' : (dd.text.match(/FAIL raft: .*/) ?? ['exit ' + dd.code])[0] }
    for (const s of corpus ? SEEDS : []) {
      const r = await run(...capped(bin('raft-diff'), [join(corpus, s, 'out'), join(corpus, s, 'in')]), { cwd: dir }, 120000)
      if (r.code !== 0) return { by: s, note: r.code === 124 ? 'timeout' : (r.text.match(/FAIL raft-diff: \d+ of \d+/) ?? ['exit ' + r.code])[0] }
    }
    return { by: 'survived', note: '' }
  }
  const build = dir => run('cargo', ['build', '-q', '-j2', '--offline', '--profile', 'mut', '-p', 'raft-harness', '--bins'], { cwd: dir, env }, 600000)

  async function worker(w) {
    const dir = join(WORK, `w${w}`)
    rmSync(dir, { recursive: true, force: true })
    cpSync(base, dir, { recursive: true })
    const b = await build(dir)
    const clean = b.code === 0 ? await tests(dir) : { by: 'nobuild', note: b.text }
    if (clean.by !== 'survived') throw new Error(`worker ${w}: the unchanged copy does not pass: ${clean.by} ${clean.note}`)
    while (next < todo.length) {
      const mu = todo[next++]
      const target = join(dir, SRC, mu.file)
      const orig = readFileSync(join(base, SRC, mu.file), 'utf8')
      writeFileSync(target, mu.text)
      const bm = await build(dir)
      const res = bm.code === 0 ? await tests(dir) : { by: 'nobuild', note: (bm.text.match(/^error.*$/m) ?? ['build failed'])[0] }
      writeFileSync(target, orig)
      const { text, ...row } = mu
      appendFileSync(RESULTS, JSON.stringify({ ...row, ...res }) + '\n')
      if (++done % 50 === 0) console.log(`${done} of ${todo.length} done, ${((Date.now() - t0) / 60000).toFixed(1)} min`)
    }
    // The copy must be whole again at the end: the unchanged code still passes.
    const again = (await build(dir)).code === 0 ? await tests(dir) : { by: 'nobuild' }
    if (again.by !== 'survived') throw new Error(`worker ${w}: the unchanged copy fails after the run`)
  }
  await Promise.all(Array.from({ length: jobs }, (_, w) => worker(w)))
  console.log(`ok mutate run: ${done} mutants in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
}

// ---- reporting ------------------------------------------------------------

function results() {
  return readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.op.localeCompare(b.op))
}
// A swap is independent when neither line mentions the other line's target:
// then the order cannot matter and the mutant is equivalent.
function swapIndependent(r) {
  const target = s => { const t = UPDATE.exec(s); return t ? t[1].replace(/^[*&]+/, '').split('(')[0] : s }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentions = (t, s) => new RegExp('(?<![\\w.])' + esc(t) + '(?!\\w)').test(s)
  return !mentions(target(r.before), r.next) && !mentions(target(r.next), r.before)
}
function report() {
  const rs = results()
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0') + '%'
  const row = (name, s) => {
    const n = k => s.filter(r => r.by === k).length
    const built = s.length - n('nobuild')
    return `| ${name} | ${s.length} | ${n('nobuild')} | ${built} | ${n('files')} (${pct(n('files'), built)}) | ${n('seed2')} | ${n('seed5')} | ${n('seed7')} | ${n('survived')} |`
  }
  console.log('| Operator | Made | Do not compile | Mutants | Caught by the 41 files | + fuzz seed 2 | + seed 5 (read-index) | + seed 7 (restart) | Survived |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const op of OPS) console.log(row(op, rs.filter(r => r.op === op)))
  console.log(row('**all**', rs))
  console.log('\n| File | Made | Do not compile | Mutants | Caught by the 41 files | + fuzz seed 2 | + seed 5 | + seed 7 | Survived |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const f of FILES) console.log(row(f, rs.filter(r => r.file === f)))
  const timeouts = rs.filter(r => r.note === 'timeout').length
  console.log(`\ncaught by a timeout (a mutant that never ends): ${timeouts}`)
  console.log('\nsurvivors:')
  for (const r of rs.filter(r => r.by === 'survived')) console.log(`  ${r.key}: ${r.before.slice(0, 110)}  =>  ${r.op === 'swap' ? '(swapped with) ' + r.next.slice(0, 80) : r.after.slice(0, 110)}`)
  console.log('\ndo not compile:')
  for (const r of rs.filter(r => r.by === 'nobuild')) console.log(`  ${r.key}: ${r.before.slice(0, 100)}  [${r.note.slice(0, 90)}]`)
}

const cmd = process.argv[2]
if (cmd === 'count' || cmd === 'list') {
  const all = allMutants(ROOT)
  if (cmd === 'list') for (const x of all) console.log(`${x.key}: ${x.before.slice(0, 100)}  =>  ${x.op === 'swap' ? '(swapped with) ' + x.next : x.after.slice(0, 100)}`)
  else {
    for (const f of FILES) console.log(f.padEnd(28), OPS.map(op => `${op} ${String(all.filter(x => x.file === f && x.op === op).length).padStart(3)}`).join('  '))
    console.log('all'.padEnd(28), OPS.map(op => `${op} ${String(all.filter(x => x.op === op).length).padStart(3)}`).join('  '), ' total', all.length)
  }
} else if (cmd === 'run') await runAll()
else if (cmd === 'report') report()
else if (cmd === 'swaps') {
  const sw = results().filter(r => r.op === 'swap' && r.by === 'survived')
  const dep = sw.filter(r => !swapIndependent(r))
  console.log(`swap survivors: ${sw.length}; independent (equivalent) ${sw.length - dep.length}; other ${dep.length}`)
  for (const r of dep) console.log(`  other: ${r.key}  ${r.before}  <->  ${r.next}`)
} else if (cmd === 'sample') {
  const n = Number(process.argv[3] ?? 40), seed = Number(process.argv[4] ?? 10)
  const others = results().filter(r => r.op !== 'swap' && r.by === 'survived')
  console.log(`${others.length} survivors that are not swaps; sample of ${Math.min(n, others.length)}, seed ${seed}`)
  for (const r of shuffled(others, seed).slice(0, n)) console.log(`  ${r.key}: ${r.before}  =>  ${r.after}`)
} else {
  console.log('usage: node mutate.mjs count | list | run | report | swaps | sample <n> <seed>')
  process.exit(2)
}
