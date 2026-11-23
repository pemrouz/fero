// E-65 X2: small shared helpers (a seeded source, a canonical printer, a JSON-lines writer).
import { appendFileSync } from 'node:fs'

export function rng(seed) { // mulberry32, as E-23 and E-57 use
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function canon(v) {
  if (v === undefined) return 'u'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

export function out(file, obj) {
  const line = JSON.stringify(obj)
  if (file) appendFileSync(file, line + '\n')
  console.log(line)
}

export function args(argv, defaults) {
  const o = { ...defaults }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const v = m[2] === undefined ? true : m[2]
    o[m[1]] = typeof defaults[m[1]] === 'number' ? Number(v) : v
  }
  return o
}
