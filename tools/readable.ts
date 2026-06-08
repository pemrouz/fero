// Build a human-readable mirror of the source tree.
//
// fero's source carries dense, verbose comments — load-bearing design rationale
// kept inline so a fresh session (human OR Claude) has the "why" at hand. Great
// for depth, heavy for navigation. This tool produces a parallel `readable/` tree
// that keeps ONLY the curated one-liners and the code, so you can skim the shape
// without wading through the essays.
//
// THE CONVENTION — `//!` marks a curated one-liner.
//   //! split opts: function values = methods, everything else = config   <- KEPT (demoted to //)
//   // Recognition rule (plan §1): function values are methods, everything   <- DROPPED
//   // else is transport/resource config. By value type, not key name.       <- DROPPED
// Every verbose block gets a `//!` lead line summarizing it for humans; the
// mirror strips the verbose body and keeps the lead (rewritten to a plain `//`).
// Trailing `code // note` comments are dropped too (unless `//!`). Block comments
// (`/* */`, `/** */`) are always dropped. Code is preserved byte-for-byte.
//
// SAFETY — the scanner is comment-aware (it never mistakes a `//` inside a string
// or template for a comment), and every emitted file is verified: the code
// skeleton (source minus all comments and whitespace) of the mirror must equal
// the source's, or the build throws. A scanner bug can't silently corrupt output.
//
// Run: `npm run readable` (writes ./readable/, gitignored). Source of truth is
// always the verbose tree; `readable/` is a regenerated build artifact — edit the
// source, not the mirror.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'readable')

//! the library trees we mirror (tests/ + tools/ aren't the reading target)
const SOURCE_DIRS = ['transport', 'log', 'resource', 'utils']
//! plus these top-level library entrypoints
const SOURCE_FILES = ['index.ts', 'internals.ts']

export type CommentRange = { start: number; end: number; kind: 'line' | 'block' }

// Scan a string for comment ranges, fully aware of JS/TS lexical context: strings
// ('…', "…"), template literals (`…` with nested `${…}` interpolations), and
// escapes are all skipped so a `//` or `/*` inside them is never mistaken for a
// comment. No regex-literal handling — this codebase has none, and a bare `/` is
// just skipped as an ordinary char (safe: it can't open a comment or a string).
export function scanComments(src: string): CommentRange[] {
  const ranges: CommentRange[] = []
  scanCode(src, 0, false, ranges)
  return ranges
}

// Scan code starting at `i`. When `stopAtBrace`, return the index just past the
// `}` that closes the current `${…}` interpolation (depth-0 brace); otherwise scan
// to EOF. Recurses through strings/templates so nesting is handled correctly.
function scanCode(src: string, i: number, stopAtBrace: boolean, ranges: CommentRange[]): number {
  const n = src.length
  let brace = 0
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const start = i
      i += 2
      while (i < n && src[i] !== '\n') i++
      ranges.push({ start, end: i, kind: 'line' })
      continue
    }
    if (c === '/' && d === '*') {
      const start = i
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      ranges.push({ start, end: i, kind: 'block' })
      continue
    }
    if (c === "'" || c === '"') {
      i = scanString(src, i, c)
      continue
    }
    if (c === '`') {
      i = scanTemplate(src, i, ranges)
      continue
    }
    if (c === '{') {
      brace++
      i++
      continue
    }
    if (c === '}') {
      if (stopAtBrace && brace === 0) return i + 1
      if (brace > 0) brace--
      i++
      continue
    }
    i++
  }
  return i
}

//! consume a '…' / "…" string (with backslash escapes); bail at newline if unterminated
function scanString(src: string, i: number, quote: string): number {
  const n = src.length
  i++
  while (i < n) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === quote) return i + 1
    if (src[i] === '\n') return i
    i++
  }
  return i
}

//! consume a `…` template; its `${…}` interpolations are scanned as code (so nested
//! strings/templates/comments inside them are handled correctly)
function scanTemplate(src: string, i: number, ranges: CommentRange[]): number {
  const n = src.length
  i++
  while (i < n) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') return i + 1
    if (c === '$' && src[i + 1] === '{') {
      i = scanCode(src, i + 2, true, ranges)
      continue
    }
    i++
  }
  return i
}

// Produce the readable form of one source string: drop every comment except `//!`
// lead lines (which are demoted to plain `//`), then tidy whitespace.
export function toReadable(src: string): string {
  const ranges = scanComments(src)
  const n = src.length
  let out = ''
  let cursor = 0
  for (const r of ranges) {
    const between = src.slice(cursor, r.start)
    const text = src.slice(r.start, r.end)
    //! keep curated one-liners (demote //! -> //)
    if (r.kind === 'line' && text.startsWith('//!')) {
      out += between + '//' + text.slice(3)
      cursor = r.end
      continue
    }
    //! a full-line comment (only whitespace around it) is removed line-and-all, so a kept
    //! lead sits flush above its code; a trailing `code // note` just loses the note
    let after = r.end
    while (after < n && (src[after] === ' ' || src[after] === '\t')) after++
    const beforeBlank = src.slice(src.lastIndexOf('\n', r.start - 1) + 1, r.start).trim() === ''
    const afterBlank = after >= n || src[after] === '\n'
    if (beforeBlank && afterBlank) {
      out += between.replace(/[ \t]+$/, '') // drop this line's indentation...
      cursor = after < n && src[after] === '\n' ? after + 1 : after // ...and its newline
    } else {
      out += between
      cursor = r.end
    }
  }
  out += src.slice(cursor)
  return tidy(out)
}

//! rtrim lines, collapse any accidental 2+ blank runs to one, and trim the file ends
function tidy(s: string): string {
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const res: string[] = []
  let blank = false
  for (const l of lines) {
    const isBlank = l === ''
    if (isBlank && blank) continue
    res.push(l)
    blank = isBlank
  }
  while (res.length && res[0] === '') res.shift()
  while (res.length && res[res.length - 1] === '') res.pop()
  return res.join('\n') + '\n'
}

// The "code skeleton": source with ALL comments removed and whitespace normalized.
// Two files with the same skeleton differ only in comments/formatting — the
// invariant the mirror must satisfy (it only edits comments). The build verifies
// skeleton(source) === skeleton(mirror) per file and refuses to emit on mismatch.
export function codeSkeleton(src: string): string {
  const ranges = scanComments(src)
  let out = ''
  let i = 0
  for (const r of ranges) {
    out += src.slice(i, r.start)
    i = r.end
  }
  out += src.slice(i)
  return out.replace(/\s+/g, ' ').trim()
}

//! recursively collect *.ts under `dir`, excluding test/perf siblings
function collect(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      collect(p, acc)
      continue
    }
    if (!name.endsWith('.ts')) continue
    if (name.endsWith('.test.ts') || name.endsWith('.perf.ts')) continue
    acc.push(p)
  }
}

export function sources(): string[] {
  const acc: string[] = []
  for (const f of SOURCE_FILES) acc.push(join(ROOT, f))
  for (const d of SOURCE_DIRS) collect(join(ROOT, d), acc)
  return acc.sort()
}

// Regenerate ./readable/ from the source tree. Verifies each file's code skeleton
// is preserved; throws on the first mismatch (a corrupt mirror is never written).
export function build(): { files: number; srcLines: number; outLines: number } {
  rmSync(OUT, { recursive: true, force: true })
  let files = 0
  let srcLines = 0
  let outLines = 0
  for (const src of sources()) {
    const text = readFileSync(src, 'utf8')
    const readable = toReadable(text)
    const rel = relative(ROOT, src)
    if (codeSkeleton(text) !== codeSkeleton(readable))
      throw new Error(`readable: code skeleton changed for ${rel} — scanner bug, refusing to write`)
    const dest = join(OUT, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readable)
    files++
    srcLines += text.split('\n').length
    outLines += readable.split('\n').length
  }
  return { files, srcLines, outLines }
}

//! run as a script (node tools/readable.ts) — generate the mirror + print a summary
if (import.meta.url === `file://${process.argv[1]}`) {
  const { files, srcLines, outLines } = build()
  const pct = srcLines ? Math.round((1 - outLines / srcLines) * 100) : 0
  console.log(`readable/ ← ${files} files · ${srcLines} → ${outLines} lines (−${pct}%)`)
}
