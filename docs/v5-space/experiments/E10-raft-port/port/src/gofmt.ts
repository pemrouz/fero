// A small subset of Go's fmt, enough for the log lines and describe
// helpers of etcd's raft to come out byte for byte the same.
// Supported verbs: %d %x %s %v %+v %q %t %%, with an optional width on %d and %s.
// Enum values must be passed as their names (strings): TypeScript numbers carry
// no String() method, so the port names them at the call site.

export const MaxUint64 = Infinity // Go's math.MaxUint64 where it is used as "no limit"

function isStringer(v: unknown): v is { String(): string } {
  return v !== null && typeof v === 'object' && typeof (v as { String?: unknown }).String === 'function'
}

export function goQuote(input: string | Uint8Array | null | undefined): string {
  let bytes: Uint8Array
  if (input == null) bytes = new Uint8Array(0)
  else if (typeof input === 'string') bytes = new TextEncoder().encode(input)
  else bytes = input
  let out = '"'
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      const c = String.fromCharCode(b)
      if (c === '"' || c === '\\') out += '\\' + c
      else if (b >= 0x20 && b < 0x7f) out += c
      else if (b === 7) out += '\\a'
      else if (b === 8) out += '\\b'
      else if (b === 12) out += '\\f'
      else if (b === 10) out += '\\n'
      else if (b === 13) out += '\\r'
      else if (b === 9) out += '\\t'
      else if (b === 11) out += '\\v'
      else out += '\\x' + b.toString(16).padStart(2, '0')
      i++
      continue
    }
    // Multi-byte UTF-8: keep valid printable runes, escape invalid bytes.
    let n = 0
    if ((b & 0xe0) === 0xc0) n = 2
    else if ((b & 0xf0) === 0xe0) n = 3
    else if ((b & 0xf8) === 0xf0) n = 4
    let ok = n > 0 && i + n <= bytes.length
    for (let k = 1; ok && k < n; k++) if ((bytes[i + k] & 0xc0) !== 0x80) ok = false
    if (!ok) {
      out += '\\x' + b.toString(16).padStart(2, '0')
      i++
      continue
    }
    out += new TextDecoder().decode(bytes.subarray(i, i + n))
    i += n
  }
  return out + '"'
}

function fmtInt(v: unknown): string {
  if (typeof v === 'number') {
    if (v === Infinity) return '18446744073709551615'
    return String(Math.trunc(v))
  }
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return `%!d(bool=${v})`
  return fmtV(v)
}

function fmtHex(v: unknown): string {
  if (typeof v === 'number') {
    if (v === Infinity) return 'ffffffffffffffff'
    return Math.trunc(v).toString(16)
  }
  if (typeof v === 'string') return Array.from(new TextEncoder().encode(v)).map(b => b.toString(16).padStart(2, '0')).join('')
  return fmtV(v)
}

export function fmtV(v: unknown, plus = false): string {
  if (v === null || v === undefined) return '<nil>'
  if (typeof v === 'number') return fmtInt(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Error) return v.message
  if (isStringer(v)) return v.String()
  if (v instanceof Uint8Array) return '[' + Array.from(v).join(' ') + ']'
  if (Array.isArray(v)) return '[' + v.map(x => fmtV(x, plus)).join(' ') + ']'
  if (v instanceof Set) return 'map[' + [...v].sort((a, b) => a - b).map(k => `${k}:{}`).join(' ') + ']'
  if (v instanceof Map) return 'map[' + [...v.keys()].sort((a, b) => a - b).map(k => `${fmtV(k)}:${fmtV(v.get(k), plus)}`).join(' ') + ']'
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => (plus ? `${k}:` : '') + fmtV(x, plus))
    return '{' + parts.join(' ') + '}'
  }
  return String(v)
}

function pad(s: string, width: number, left: boolean): string {
  if (width <= 0 || s.length >= width) return s
  return left ? s.padEnd(width) : s.padStart(width)
}

export function sprintf(format: string, ...args: unknown[]): string {
  let out = ''
  let ai = 0
  for (let i = 0; i < format.length; i++) {
    const c = format[i]
    if (c !== '%') {
      out += c
      continue
    }
    i++
    let plus = false
    let minus = false
    while (format[i] === '+' || format[i] === '-' || format[i] === '#') {
      if (format[i] === '+') plus = true
      if (format[i] === '-') minus = true
      i++
    }
    let width = 0
    while (format[i] >= '0' && format[i] <= '9') {
      width = width * 10 + (format.charCodeAt(i) - 48)
      i++
    }
    const verb = format[i]
    if (verb === '%') {
      out += '%'
      continue
    }
    if (ai >= args.length) {
      out += `%!${verb}(MISSING)`
      continue
    }
    const a = args[ai++]
    let s: string
    switch (verb) {
      case 'd':
        s = fmtInt(a)
        break
      case 'x':
        s = fmtHex(a)
        break
      case 's':
        s = a instanceof Uint8Array ? new TextDecoder().decode(a) : fmtV(a, plus)
        break
      case 'v':
        s = fmtV(a, plus)
        break
      case 'q':
        s = typeof a === 'string' || a instanceof Uint8Array || a == null ? goQuote(a as string | Uint8Array | null) : goQuote(fmtV(a))
        break
      case 't':
        s = a ? 'true' : 'false'
        break
      default:
        s = `%!${verb}(${fmtV(a)})`
    }
    out += pad(s, width, minus)
  }
  if (ai < args.length) {
    out += '%!(EXTRA ' + args.slice(ai).map(x => fmtV(x)).join(', ') + ')'
  }
  return out
}

// Go's fmt.Sprint: spaces between operands when neither side is a string.
export function sprint(...args: unknown[]): string {
  let out = ''
  for (let i = 0; i < args.length; i++) {
    if (i > 0 && typeof args[i] !== 'string' && typeof args[i - 1] !== 'string') out += ' '
    out += fmtV(args[i])
  }
  return out
}

// Go's fmt.Sprintln: always spaces between operands, then a newline.
export function sprintln(...args: unknown[]): string {
  return args.map(a => fmtV(a)).join(' ') + '\n'
}
