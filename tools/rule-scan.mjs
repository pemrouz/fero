// The marker scan. Lists every place where code is wrapped in a rule marker, and checks each id
// against the ledger. Plain node 22, nothing installed.
//
// A marker is `rule!("id", ...)` in Rust (crates/rule) and `rule('id', ...)` in TypeScript
// (rule.ts). A marker inside a comment is not a marker.
//
//   node tools/rule-scan.mjs                 scan the repo: crates/ and every TypeScript source
//   node tools/rule-scan.mjs <path> ...      scan these files or folders instead (for example a
//                                            marked copy that lives outside the repo)
//   --list     print one line per site: file:line id
//   --json     print the sites as JSON and nothing else
//
// It fails (exit 1) on an id the ledger does not hold, and when two ledger ids share a marker
// hash (the Rust marker compares 64-bit FNV-1a hashes of ids). Ids that start with `test.` are
// the marker's own test ids and are skipped. It ends `ok rule-scan: ...` when all is well.
// A rule with sites in more than three places is listed as smeared (BUILD 2.6).
import fs from 'node:fs'
import path from 'node:path'
import { root, spec, readJson } from './ledger-lib.mjs'

const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'spec', 'docs'])
const RUST = /\brule!\s*\(\s*"([^"\n]*)"/g
// Not `x.rule(...)`: a method of that name on some other object is not the marker.
const TS = /(?<![.\w$])rule\s*(?:<[^>()]*>)?\(\s*(?:'([^'\n]*)'|"([^"\n]*)")\s*,/g

// Blank out comments (same length, line breaks kept), so a marker in a comment is not counted.
// Strings are walked over so that `//` inside a string does not start a comment: plain strings,
// Rust raw strings (r"..", r#".."#, with or without a leading b), and in TypeScript template
// strings and regular-expression literals. With `strings` given, each position inside a string
// is set to 1 there, so a marker that is only text in a string can be told apart.
export function mask(src, rust, strings) {
  const out = src.split('')
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ' }
  const inString = (a, b) => { if (strings) strings.fill(1, a, Math.min(b, src.length)) }
  const word = /[A-Za-z0-9_$]/
  let i = 0
  let last = ''   // the last character of code that is not a space (for telling a regex from a division)
  const n = src.length
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue }
    if (c === '/' && d === '*') {
      let j = i + 2, depth = 1
      while (j < n && depth > 0) {
        if (rust && src[j] === '/' && src[j + 1] === '*') { depth++; j += 2 } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2 } else j++
      }
      blank(i, j); i = j; continue
    }
    if (rust && (c === 'r' || (c === 'b' && d === 'r')) && !(i > 0 && word.test(src[i - 1]))) {
      // a raw string: r, any number of #, a quote; it ends at a quote followed by as many #
      let j = i + (c === 'b' ? 2 : 1), hashes = 0
      while (src[j] === '#') { hashes++; j++ }
      if (src[j] === '"') {
        const end = src.indexOf('"' + '#'.repeat(hashes), j + 1)
        const stop = end < 0 ? n : end + 1 + hashes
        inString(i, stop); i = stop; last = '"'; continue
      }
    }
    if (c === '"' || (!rust && (c === "'" || c === '`'))) {
      let j = i + 1
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      inString(i, j + 1); i = j + 1; last = c; continue
    }
    if (rust && c === "'") {
      // a char literal ('x', '\n', '\'') or a lifetime ('a): only skip the literal
      if (d === '\\') { let j = i + 2; while (j < n && src[j] !== "'") j++; i = j + 1; last = c; continue }
      if (src[i + 2] === "'") { i += 3; last = c; continue }
    }
    if (!rust && c === '/' && (last === '' || '(,=:[!&|?{};<>+-*%~^'.includes(last))) {
      // a regular-expression literal (a `/` where a value is expected); it ends on its own line
      let j = i + 1, cls = false
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      if (src[j] === '/') { inString(i, j + 1); i = j + 1; last = '/'; continue }
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') last = c
    i++
  }
  return out.join('')
}

function files(p, out) {
  const st = fs.statSync(p)
  if (st.isFile()) { if (/\.(rs|ts|mts)$/.test(p) && !p.endsWith('.d.ts')) out.push(p); return }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) files(path.join(p, e.name), out) }
    else if (e.isFile()) files(path.join(p, e.name), out)
  }
}

// Every marker site under the given files and folders: { file, line, id, lang }.
export function scan(paths) {
  const list = []
  for (const p of paths) files(p, list)
  list.sort()
  const sites = []
  for (const file of list) {
    const rust = file.endsWith('.rs')
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes('rule')) continue
    const strings = new Uint8Array(src.length)
    const text = mask(src, rust, strings)
    const re = rust ? RUST : TS
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      if (strings[m.index]) continue // the marker's name is text inside a string
      const id = m[1] ?? m[2] ?? m[3]
      const line = text.slice(0, m.index).split('\n').length
      sites.push({ file, line, id, lang: rust ? 'rust' : 'ts' })
    }
  }
  return sites
}

// 64-bit FNV-1a of an id, as crates/rule hashes it.
export function hash(id) {
  let h = 0xcbf29ce484222325n
  for (const b of Buffer.from(id, 'utf8')) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
  return h === 0n || h === 0xffffffffffffffffn ? 1n : h
}

function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const given = args.filter(a => !a.startsWith('--')).map(a => path.resolve(a))
  const base = given.length ? null : root
  const roots = given.length ? given : [root]
  for (const r of roots) if (!fs.existsSync(r)) { console.log(`FAILED rule-scan: no such path: ${r}`); process.exit(1) }
  const ledger = readJson(spec('ledger.json'))
  const ids = new Map(ledger.map(r => [r.id, r]))
  const all = scan(roots)
  const show = f => base ? path.relative(base, f) : f
  const sites = all.filter(s => !s.id.startsWith('test.'))
  if (flags.has('--json')) { console.log(JSON.stringify(sites.map(s => ({ ...s, file: show(s.file) })), null, 1)); return }

  const errors = []
  for (const s of sites) if (!ids.has(s.id)) errors.push(`${show(s.file)}:${s.line}: the ledger holds no rule "${s.id}"`)
  const seen = new Map()
  for (const id of ids.keys()) {
    const h = hash(id)
    if (seen.has(h)) errors.push(`rules "${seen.get(h)}" and "${id}" share a marker hash`)
    seen.set(h, id)
  }

  const by = new Map()
  for (const s of sites) { if (!by.has(s.id)) by.set(s.id, []); by.get(s.id).push(s) }
  if (flags.has('--list')) for (const s of sites) console.log(`${show(s.file)}:${s.line} ${s.id}`)
  const smeared = [...by].filter(([, v]) => v.length > 3).map(([id, v]) => `${id} (${v.length})`)
  const layers = {}
  for (const id of by.keys()) { const l = ids.get(id)?.layer ?? '?'; layers[l] = (layers[l] ?? 0) + 1 }
  const rust = sites.filter(s => s.lang === 'rust').length
  console.log(`rule-scan: ${given.length ? roots.join(', ') : 'the repo'}`)
  console.log(`  sites    ${sites.length} (${rust} in Rust, ${sites.length - rust} in TypeScript); ${all.length - sites.length} test.* sites skipped`)
  console.log(`  rules    ${by.size} of the ledger's ${ids.size} ids have a site`)
  console.log(`  layers   ${Object.keys(layers).sort().map(l => `${l} ${layers[l]}`).join('  ') || 'none'}`)
  console.log(`  smeared  ${smeared.length ? smeared.join(', ') : 'none'} (a rule with sites in more than three places)`)
  if (errors.length) {
    console.log(`\nFAILED rule-scan: ${errors.length} problem${errors.length === 1 ? '' : 's'}`)
    for (const e of errors.slice(0, 60)) console.log('  - ' + e)
    process.exit(1)
  }
  console.log(`\nok rule-scan: ${sites.length} sites, ${by.size} of ${ids.size} ledger ids have a site, no unknown id, no shared hash`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main()
