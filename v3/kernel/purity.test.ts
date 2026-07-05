//! The import-lint (plan §3.1): kernel/ may not touch node:*, timers, Date.now, Math.random, or process.
// Purity is what makes the kernel deterministic under the sim — and v2 proved
// unenforced boundaries are violated within one milestone, so this is a CI
// gate, not a convention. One setTimeout inside kernel/ would silently break
// determinism for every seed thereafter; this test makes that a red build the
// day it lands. The comment stripper is STRING-AWARE (a naive line.replace on
// '//' truncates at a '//' inside a string literal, hiding everything after it
// — an adversarial-review finding), and dynamic `import(` is banned alongside
// static node: imports.

import { test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const KERNEL = join(dirname(fileURLToPath(import.meta.url)))

//! banned: anything that reaches outside the Env seam — including dynamic import(), which no from-clause regex sees.
const BANNED = [
  /from\s+['"]node:/,          // no node builtins — I/O lives in shell/
  /\brequire\s*\(/,
  /\bimport\s*\(/,             // dynamic import bypasses the static-import scan entirely
  /\bsetTimeout\b/, /\bsetInterval\b/, /\bsetImmediate\b/, /\bqueueMicrotask\b/,
  /\bDate\.now\b/, /\bnew Date\b/,
  /\bMath\.random\b/,          // randomness comes from env.rng (seeded)
  /\bprocess\./,
  /\bperformance\.now\b/,      // time comes from env.now (virtual in sim)
  /\bfetch\s*\(/,
]

//! relative-only imports: the kernel may import kernel files, nothing above it (api/shell/sim import the kernel, never the reverse).
const IMPORT = /from\s+['"]([^'"]+)['"]/g

//! strip — remove // and /* */ comments WITHOUT trusting regexes: a five-state scanner that respects
// single/double/backtick strings and escapes, so banned tokens can neither hide in comments nor be
// falsely hidden by a '//' occurring inside a string.
const strip = (src: string): string => {
  let out = ''
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    switch (mode) {
      case 'code':
        if (c === '/' && n === '/') { mode = 'line'; i++ }
        else if (c === '/' && n === '*') { mode = 'block'; i++ }
        else { if (c === "'" || c === '"' || c === '`') mode = c; out += c }
        break
      case 'line':
        if (c === '\n') { mode = 'code'; out += c }
        break
      case 'block':
        if (c === '*' && n === '/') { mode = 'code'; i++ }
        else if (c === '\n') out += c
        break
      default: // inside a string/template literal — comments cannot start here; strings survive verbatim
        if (c === '\\') { out += c + (n ?? ''); i++ }
        else { if (c === mode) mode = 'code'; out += c }
    }
  }
  return out
}

test('kernel sources are pure: no I/O, no ambient time, no ambient randomness', () => {
  const files = readdirSync(KERNEL).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.perf.'))
  assert.ok(files.length >= 5, `expected kernel sources, saw ${files.join(', ')}`)
  for (const f of files) {
    const src = strip(readFileSync(join(KERNEL, f), 'utf8'))
    for (const re of BANNED) assert.ok(!re.test(src), `${f} violates kernel purity: ${re}`)
    for (const m of src.matchAll(IMPORT))
      assert.ok(m[1].startsWith('./'), `${f} imports outside kernel/: ${m[1]}`)
  }
})

test('the stripper itself: comments hide nothing, strings hide nothing', () => {
  //! banned tokens in comments must NOT trip the lint; banned tokens after a string-embedded // MUST
  assert.ok(!/setTimeout/.test(strip('// setTimeout(x)\nconst a = 1')))
  assert.ok(!/setTimeout/.test(strip('/* setTimeout(x) */ const a = 1')))
  assert.ok(/Date\.now/.test(strip(`const url = 'proto://host'; const t = Date.now()`)))
  assert.ok(/import\s*\(/.test(strip(`const m = await import('node:fs')`)))
})
