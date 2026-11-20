// A copy of the study's strip tool, kept here so this folder runs from a clean checkout: strip every @ts-expect-error
// line from a copy of a checked folder, run tsc (from PATH), and pair each error with its comment's line.
//   node strip.mjs <checkdir> <outdir> [full]
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
const src = process.argv[2], out = process.argv[3], full = process.argv[4] === 'full'
const expected = []
for (const f of readdirSync(src)) {
  if (f === 'tsconfig.json') { copyFileSync(join(src, f), join(out, f)); continue }
  if (!f.endsWith('.ts')) continue
  const lines = readFileSync(join(src, f), 'utf8').split('\n'); const kept = []
  for (const l of lines) {
    const m = l.match(/^\s*\/\/ @ts-expect-error (.*)$/)
    if (m) expected.push([f, kept.length + 1, m[1]]); else kept.push(l)
  }
  writeFileSync(join(out, f), kept.join('\n'))
}
let txt = ''
try { execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { encoding: 'utf8' }) } catch (e) { txt = e.stdout }
const blocks = []; for (const l of txt.split('\n')) { if (/^\S+\.ts\(\d+,\d+\): error/.test(l)) blocks.push([l]); else if (blocks.length && l.trim()) blocks.at(-1).push(l) }
console.log(`stripped ${expected.length} lines; tsc reports ${blocks.length} errors`)
const byLine = new Map(blocks.map((b) => { const m = b[0].match(/^(\S+)\((\d+),\d+\): error (TS\d+): (.*)$/); return [`${basename(m[1])}:${m[2]}`, full ? `${m[3]} ${b.join(' | ').replace(/\s+/g, ' ').slice(0, 900)}` : `${m[3]} ${m[4].slice(0, 160)}`] }))
let ok = 0
for (const [f, line, why] of expected) { const got = byLine.get(`${f}:${line}`); if (got) ok++; console.log(`${f}:${line}  [${why}]\n    -> ${got ?? 'NO ERROR HERE'}`) }
const lines = new Set(expected.map(([f, l]) => `${f}:${l}`))
for (const [k, v] of byLine) if (!lines.has(k)) console.log(`UNEXPECTED ${k} ${v}`)
console.log(`${ok} of ${expected.length} stripped lines error at their own line`)
