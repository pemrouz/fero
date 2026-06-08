import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toReadable, codeSkeleton, scanComments, sources } from './readable.ts'

test('drops a full-line comment, keeps the code', () => {
  const out = toReadable(`// gone\nconst x = 1\n`)
  assert.equal(out, `const x = 1\n`)
})

test('keeps a //! lead line (demoted), flush above its code, verbose body gone', () => {
  const out = toReadable(`//! kept one-liner\n// verbose body\nconst x = 1\n`)
  assert.equal(out, `// kept one-liner\nconst x = 1\n`)
})

test('strips a trailing comment but keeps the code before it', () => {
  const out = toReadable(`const x = 1 // trailing note\n`)
  assert.equal(out, `const x = 1\n`)
})

test('keeps a trailing //! note (demoted)', () => {
  const out = toReadable(`const x = 1 //! keep this\n`)
  assert.equal(out, `const x = 1 // keep this\n`)
})

test('drops block and JSDoc comments', () => {
  assert.equal(toReadable(`/* block */\nconst x = 1\n`), `const x = 1\n`)
  assert.equal(toReadable(`/**\n * doc\n */\nconst x = 1\n`), `const x = 1\n`)
})

test('a // inside a string is NOT a comment', () => {
  const src = `const u = 'http://x' // real comment\n`
  assert.equal(toReadable(src), `const u = 'http://x'\n`)
})

test('a // inside a template literal is NOT a comment', () => {
  const src = 'const u = `see //docs ${x}` // real comment\n'
  assert.equal(toReadable(src), 'const u = `see //docs ${x}`\n')
})

test('handles ${} interpolation with nested string containing } and //', () => {
  // the `'}'` inside the interpolation must not end the interpolation early,
  // and the `//foo` inside that string must not be read as a comment.
  const src = 'const s = `a${b || \'}//foo\'}c` // drop me\n'
  assert.equal(toReadable(src), 'const s = `a${b || \'}//foo\'}c`\n')
})

test('respects backslash escapes in strings (\\x00 separators)', () => {
  const src = `const k = key.join('\\x00') // join with NUL\n`
  assert.equal(toReadable(src), `const k = key.join('\\x00')\n`)
})

test('removes a full-line comment block entirely (no residual blank)', () => {
  const src = `const a = 1\n// one\n// two\n// three\nconst b = 2\n`
  assert.equal(toReadable(src), `const a = 1\nconst b = 2\n`)
})

test('preserves a genuine blank line that separated code from a stripped block', () => {
  const src = `const a = 1\n\n// body\n//! lead\nconst b = 2\n`
  assert.equal(toReadable(src), `const a = 1\n\n// lead\nconst b = 2\n`)
})

test('codeSkeleton ignores comments and whitespace', () => {
  const a = `  const x = 1 // note\nconst y = 2\n`
  const b = `const x = 1\n\n\nconst y = 2 // different note\n`
  assert.equal(codeSkeleton(a), codeSkeleton(b))
})

test('scanComments finds line and block ranges, not string contents', () => {
  const src = `const u = 'a//b'\n// c\n/* d */`
  const kinds = scanComments(src).map((r) => r.kind)
  assert.deepEqual(kinds, ['line', 'block'])
})

test('every source file: readable form preserves the code skeleton', () => {
  for (const f of sources()) {
    const text = readFileSync(f, 'utf8')
    assert.equal(codeSkeleton(toReadable(text)), codeSkeleton(text), `skeleton drift in ${f}`)
  }
})

test('readable output never contains a //! marker (all demoted)', () => {
  for (const f of sources()) {
    const out = toReadable(readFileSync(f, 'utf8'))
    assert.ok(!out.includes('//!'), `undemoted //! left in ${f}`)
  }
})
