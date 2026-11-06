// Port of github.com/cockroachdb/datadriven v1.0.3: the file format, the line
// parser and the byte-for-byte comparison. Only reading is ported (no -rewrite).
import { readFileSync } from 'node:fs'

export type CmdArg = { Key: string; Vals: string[] }

export class TestData {
  Pos = ''
  Cmd = ''
  CmdArgs: CmdArg[] = []
  Input = ''
  Expected = ''
  Arg(key: string): CmdArg | undefined {
    return this.CmdArgs.find(a => a.Key === key)
  }
  // ScanArgs for a single integer argument.
  ScanArgInt(key: string): number {
    const a = this.Arg(key)
    if (!a) throw new Error(`${this.Pos}: missing argument: ${key}`)
    return scanInt(a, 0)
  }
}

export function scanInt(a: CmdArg, i: number): number {
  const v = a.Vals[i]
  if (!/^-?\d+$/.test(v)) throw new Error(`strconv.ParseInt: parsing ${JSON.stringify(v)}: invalid syntax`)
  return Number(v)
}

export function scanBool(a: CmdArg, i: number): boolean {
  const v = a.Vals[i]
  if (['1', 't', 'T', 'true', 'TRUE', 'True'].includes(v)) return true
  if (['0', 'f', 'F', 'false', 'FALSE', 'False'].includes(v)) return false
  throw new Error(`strconv.ParseBool: parsing ${JSON.stringify(v)}: invalid syntax`)
}

export function ParseLine(line: string): [string, CmdArg[]] {
  line = line.trim()
  if (line === '') return ['', []]
  const origLine = line
  const fail = (): never => {
    const column = origLine.length - line.length + 1
    throw new Error(`cannot parse directive at column ${column}: ${origLine}`)
  }
  const until = (chars: string): string => {
    let idx = -1
    for (let k = 0; k < line.length; k++) if (chars.includes(line[k])) { idx = k; break }
    if (idx === -1) idx = line.length
    const res = line.slice(0, idx)
    line = line.slice(idx)
    return res
  }
  const cmd = until(' ')
  if (cmd === '') fail()
  line = line.trim()
  const args: CmdArg[] = []
  while (line !== '') {
    const arg: CmdArg = { Key: until(' ='), Vals: [] }
    if (arg.Key === '') fail()
    if (line !== '' && line[0] === '=') {
      line = line.slice(1)
      if (line === '' || line[0] === ' ') {
        arg.Vals = ['']
      } else if (line[0] !== '(') {
        arg.Vals = [until(' ')]
      } else {
        let pos = 1
        let nest = 1
        let lastValStart = pos
        while (nest > 0) {
          if (pos === line.length) fail()
          const r = line[pos]
          pos++
          if (r === ',') {
            if (nest === 1) {
              arg.Vals.push(line.slice(lastValStart, pos - 1))
              while (pos < line.length && line[pos] === ' ') pos++
              lastValStart = pos
            }
          } else if (r === '(') nest++
          else if (r === ')') nest--
        }
        arg.Vals.push(line.slice(lastValStart, pos - 1))
        line = line.slice(pos).trim()
      }
    }
    args.push(arg)
    line = line.trim()
  }
  return [cmd, args]
}

// readTestData yields the directives of one file, as testDataReader.Next does.
export function* readTestData(path: string, sourceName: string): Generator<TestData> {
  const text = readFileSync(path, 'utf8')
  // bufio.Scanner: lines split on \n, a trailing \r dropped, no final empty token.
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let k = 0; k < lines.length; k++) lines[k] = lines[k].replace(/\r$/, '')
  let ln = 0
  const scan = (): string | null => (ln < lines.length ? lines[ln++] : null)
  for (;;) {
    let raw = scan()
    if (raw === null) return
    const d = new TestData()
    d.Pos = `${sourceName}:${ln}`
    let line = raw.trim()
    if (line.startsWith('#')) continue
    while (line.endsWith('\\')) {
      const next = scan()
      if (next === null) break
      line = line.slice(0, -1) + ' ' + next.trim()
    }
    const [cmd, args] = ParseLine(line)
    if (cmd === '') continue
    d.Cmd = cmd
    d.CmdArgs = args
    let buf = ''
    let separator = false
    for (;;) {
      raw = scan()
      if (raw === null) break
      if (raw === '----') {
        separator = true
        break
      }
      buf += raw + '\n'
    }
    d.Input = buf.trim()
    if (separator) {
      // readExpected
      let out = ''
      let l = scan()
      let allowBlankLines = false
      if (l === '----') allowBlankLines = true
      if (allowBlankLines) {
        for (;;) {
          l = scan()
          if (l === null) break
          if (l === '----') {
            const l2 = scan()
            if (l2 !== null) {
              if (l2 === '----') {
                const l3 = scan()
                if (l3 !== null && l3 !== '') throw new Error('non-blank line after end of double ---- separator section')
                break
              }
              out += l + '\n' + l2 + '\n'
              continue
            }
          }
          out += l + '\n'
        }
      } else {
        while (l !== null) {
          if (l.trim() === '') break
          out += l + '\n'
          l = scan()
        }
      }
      d.Expected = out
    }
    yield d
  }
}

export type FileResult = {
  file: string
  directives: number
  passed: number
  ok: boolean
  failure?: { pos: string; cmd: string; expected: string; actual: string; error?: string }
}

// runTest runs every directive; like Go's datadriven, the first mismatch ends the file.
export function runTest(path: string, sourceName: string, f: (d: TestData) => string): FileResult {
  const res: FileResult = { file: sourceName, directives: 0, passed: 0, ok: true }
  for (const d of readTestData(path, sourceName)) {
    res.directives++
    let actual: string
    try {
      actual = f(d)
    } catch (e) {
      res.ok = false
      res.failure = { pos: d.Pos, cmd: d.Cmd, expected: d.Expected, actual: '', error: (e as Error).stack ?? String(e) }
      return res
    }
    if (actual !== '' && !actual.endsWith('\n')) actual += '\n'
    if (d.Expected !== actual) {
      res.ok = false
      res.failure = { pos: d.Pos, cmd: d.Cmd, expected: d.Expected, actual }
      return res
    }
    res.passed++
  }
  return res
}
