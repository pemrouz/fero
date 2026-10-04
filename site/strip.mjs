// next/strip.mjs — the kernel build for the page. Zero dependencies (node: builtins only).
//
// 1. Strips the runtime import cones of the entries below into ./lib with Node's
//    stripTypeScriptTypes (file-for-file, `.ts` specifiers → `.js`), one `seen` set so every
//    module lands exactly once. The cone is the deterministic kernel (kernel/*.ts) plus the
//    simulation executive (sim/exec.ts, sim/monitors.ts, sim/harness.ts): the same kernel
//    files the TCP shell runs, here driven by the simulator's virtual network instead.
// 2. Gates: no `node:` specifier survives in lib/ (kernel/purity.test.ts enforces this for the
//    kernel; the gate re-checks the whole cone); every emitted module passes `node --check`.
// 3. Writes lib/manifest.json (the module list + byte count) — the footer prints it.
//
// Run: node strip.mjs            (reads the repo this site/ sits in, or FERO_REPO)
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(process.env.FERO_REPO ?? join(here, '..'))
const out = join(here, 'lib')

const ENTRIES = [
  'sim/exec.ts',      // the executive: virtual time, the event queue, links, faults, disks
  'sim/monitors.ts',  // the invariant monitors that run after every event
  'sim/harness.ts',   // cluster() / client() / writes() — the scenario vocabulary
  'kernel/ring.ts',   // the consistent-hash ring (owner of a row)
  'kernel/codec.ts',  // frame verbs, for labelling traffic
  'sim/shrink.ts',    // sweepBuild — the exact scenario `npm run sim -- --seeds N` sweeps (its CLI block needs node:fs/url → shim/)
  'tools/debug/eli5.mjs', // the debugger's plain-words glossary (the browser already loads these exact bytes in viewer.html)
]
// node:fs / node:url are imported only by sim/shrink.ts's CLI block (guarded by a try/catch isMain);
// the shims throw if anything ever calls them, so a browser can never silently "write a capture".
const ALIAS = { 'node:fs': join(here, 'shim', 'fs.js'), 'node:url': join(here, 'shim', 'url.js') }

rmSync(out, { recursive: true, force: true })
const SPEC = /(['"])(\.[^'"\n]*?)\.ts\1/g
const MJS = /(['"])(\.[^'"\n]*?\.mjs)\1/g
const NODE = /(from\s*|import\s*\(?\s*)(['"])(node:[a-z_/]+)\2/g
const seen = new Map() // abs .ts → rel .js
const queue = ENTRIES.map((e) => join(repo, e))
let bytes = 0

function emit(file) {
  if (seen.has(file)) return
  const src = readFileSync(file, 'utf8')
  const isMjs = file.endsWith('.mjs')
  let js = isMjs ? src : stripTypeScriptTypes(src, { mode: 'strip', sourceMap: false })
  const rel = relative(repo, file).replace(/\.ts$/, '.js')
  seen.set(file, rel)
  for (const m of js.matchAll(SPEC)) {
    const dep = resolve(dirname(file), m[2] + '.ts')
    if (!seen.has(dep) && existsSync(dep)) queue.push(dep)
  }
  for (const m of js.matchAll(MJS)) {
    const dep = resolve(dirname(file), m[2])
    if (!seen.has(dep) && existsSync(dep)) queue.push(dep)
  }
  js = js.replace(SPEC, (_, q, spec) => `${q}${spec}.js${q}`)
  const dest = join(out, rel)
  js = js.replace(NODE, (_, lead, q, spec) => {
    const target = ALIAS[spec]
    if (!target) throw new Error(`strip: no shim for ${spec} in ${rel}`)
    let r = relative(dirname(dest), target).split('\\').join('/')
    if (!r.startsWith('.')) r = './' + r
    return `${lead}${q}${r}${q}`
  })
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, js)
  bytes += Buffer.byteLength(js)
}
while (queue.length) emit(queue.pop())

const walk = (dir, acc = []) => {
  for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p, acc) : acc.push(p) }
  return acc
}
for (const f of walk(out)) {
  const txt = readFileSync(f, 'utf8')
  if (/from\s*['"]node:|import\s*\(\s*['"]node:/.test(txt)) throw new Error(`gate: a node: import survived in ${relative(here, f)}`)
  execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
}
const head = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD']).toString().trim()
const modules = [...seen.values()].sort()
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ head, entries: ENTRIES, modules, bytes }, null, 1))
console.log(`strip: ${modules.length} modules, ${(bytes / 1024).toFixed(0)} KB from ${repo} @ ${head}`)
console.log(modules.join('\n'))
