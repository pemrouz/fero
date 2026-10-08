//! Tier-3 examples on a real terminal: the two roles that read what you type (40's join.ts, 41's
// edit.ts) redraw their whole screen on every change, and a line you are halfway through typing must
// come back under the new frame — even one wider than the terminal, and on every redraw, not only the
// first. The example checks cannot see this: they run with no terminal, so readline never draws. Here
// each role runs on a pseudo-terminal (python3's pty module, the one helper this needs; the suite
// skips without it), the test types a long line without Enter, writes to the resource from this
// process three times, and replays the bytes the role wrote through a small terminal model to read
// the screen a person would see. Then Ctrl-C must still stop the role cleanly.

import '../utils/battery.ts'

import { test } from 'node:test'
import assert from 'node:assert'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { ports } from '#utils'
import { fero } from '../api/index.ts'

const ROOT = path.join(import.meta.dirname, '..', 'examples')
const COLS = 40
const hasPty = spawnSync('python3', ['-c', 'import pty, fcntl, termios'], { stdio: 'ignore' }).status === 0

// the bridge: runs argv on a pty of COLS x ROWS, copies our stdin to the pty and the pty to our stdout,
// and exits with the role's exit code; SIGTERM kills the role first, so a failed test leaks nothing
const BRIDGE = `
import os, pty, sys, select, signal, struct, fcntl, termios
cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execv(argv[0], argv)
def stop(*_):
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
    os._exit(1)
signal.signal(signal.SIGTERM, stop)
ins = [fd, 0]
while True:
    r = select.select(ins, [], [])[0]
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: break
        sys.stdout.buffer.write(d); sys.stdout.buffer.flush()
    if 0 in r:
        d = os.read(0, 65536)
        if d: os.write(fd, d)
        else: ins = [fd]
st = os.waitpid(pid, 0)[1]
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
`

// the screen a terminal shows for these bytes, as logical lines: a row the terminal wrapped is joined
// to the next. Enough of a terminal for what readline and console.clear() write: printable text with
// deferred autowrap, CR, LF, cursor up/down/left/right, column, position, erase down and erase line;
// colours and private modes are ignored.
const screen = (out: string, cols = COLS): string[] => {
  const rows: string[][] = [], wrapped: boolean[] = []
  let r = 0, c = 0
  const row = (i: number) => (rows[i] ??= [])
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (ch === '\x1b') {
      const m = /^\x1b\[([?>=]?)([\d;]*)([@-~])/.exec(out.slice(i, i + 32))
      if (!m) continue
      i += m[0].length - 1
      if (m[1]) continue
      const [a, b] = m[2].split(';').map((x) => (x === '' ? undefined : Number(x)))
      switch (m[3]) {
        case 'A': r = Math.max(0, r - (a || 1)); break
        case 'B': r += a || 1; break
        case 'C': c = Math.min(cols - 1, c + (a || 1)); break
        case 'D': c = Math.max(0, Math.min(c, cols - 1) - (a || 1)); break
        case 'G': c = (a || 1) - 1; break
        case 'H': case 'f': r = (a || 1) - 1; c = (b || 1) - 1; break
        case 'J':
          if (!a) { row(r).length = Math.min(row(r).length, c); wrapped[r] = false; rows.length = Math.min(rows.length, r + 1); wrapped.length = Math.min(wrapped.length, r + 1) }
          else if (a === 2 || a === 3) { rows.length = 0; wrapped.length = 0 }
          break
        case 'K':
          if (!a) { row(r).length = Math.min(row(r).length, c); wrapped[r] = false }
          else if (a === 2) { rows[r] = []; wrapped[r] = false }
          break
      }
    } else if (ch === '\r') c = 0
    else if (ch === '\n') r++
    else if (ch === '\b') c = Math.max(0, Math.min(c, cols - 1) - 1)
    else if (ch >= ' ') {
      if (c >= cols) { wrapped[r] = true; r++; c = 0 }
      row(r)[c++] = ch
    }
  }
  const lines: string[] = []
  let carry = ''
  for (let i = 0; i < rows.length; i++) {
    const text = Array.from(rows[i] ?? [], (x) => x ?? ' ').join('')
    if (wrapped[i]) { carry += text; continue }
    lines.push((carry + text).trimEnd())
    carry = ''
  }
  if (carry) lines.push(carry.trimEnd())
  while (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

test('the terminal model: deferred wrap joins rows, cursor-up then erase-down rewrites from that row', () => {
  assert.deepEqual(screen('\x1b[1;1H\x1b[0JHEAD\r\nrow one\r\n' + 'x'.repeat(50), 40), ['HEAD', 'row one', 'x'.repeat(50)])
  assert.deepEqual(screen('HEAD\r\nrow one\r\n\x1b[1A\x1b[1G\x1b[0Jtyped', 40), ['HEAD', 'typed'], 'climbing one row first erases the row above')
  assert.deepEqual(screen('\x1b[32mgreen\x1b[39m\r\n\x1b[?2004h', 40), ['green'])
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (check: () => unknown, ms = 15_000): Promise<boolean> => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (check()) return true
  return !!check()
}
// p settled, or 'timeout' after ms (the timer is cleared, so it never holds the process open)
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let t: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms) })]).finally(() => clearTimeout(t))
}
const exited = (p: ChildProcess) => new Promise<number | null>((resolve) => p.exitCode !== null ? resolve(p.exitCode) : p.once('exit', (code) => resolve(code)))

// one role on a pty: its raw output, its screen, a way to type
const onPty = (dir: string, argv: string[], env: NodeJS.ProcessEnv) => {
  const p = spawn('python3', ['-c', BRIDGE, String(COLS), '50', process.execPath, ...argv], { cwd: path.join(ROOT, dir), env: { ...env, TERM: 'xterm' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  p.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d })
  p.stderr!.setEncoding('utf8').on('data', (d: string) => { out += d })
  return { p, out: () => out, lines: () => screen(out), type: (s: string) => p.stdin!.write(s), exited: exited(p) }
}

// a role off the pty, stopped with Ctrl-C at the end
const role = (dir: string, argv: string[], env: NodeJS.ProcessEnv) => {
  const p = spawn(process.execPath, argv, { cwd: path.join(ROOT, dir), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d })
  return { p, out: () => out, exited: exited(p) }
}

// the shared story: start the server role, start the typing role on a pty, type a line that wraps,
// make three changes from this process, and the screen must end with the whole frame, then the line
const story = async (o: { dir: string, server: string[], ready: string, typist: string[], head: string, typed: string, change: (env: NodeJS.ProcessEnv, i: number) => Promise<() => Promise<void>>, shown: (i: number) => (frame: string[]) => boolean, last: (frame: string[]) => boolean }) => {
  const env = { ...process.env, FERO_RENDEZVOUS: `127.0.0.1:${await ports.outside()}` }
  const server = role(o.dir, o.server, env)
  const tty = onPty(o.dir, o.typist, env)
  let done: (() => Promise<void>) | undefined
  const frame = () => { const l = tty.lines(); return l.slice(l.findLastIndex((x) => x.startsWith(o.head))) }
  const dump = () => `--- the screen ---\n${tty.lines().join('\n')}\n--- the last 600 bytes ---\n${JSON.stringify(tty.out().slice(-600))}`
  try {
    assert.ok(await until(() => server.out().includes(o.ready)), `the server is up\n${server.out()}`)
    assert.ok(await until(() => frame().length > 0), `the typing role drew its first frame\n${dump()}`)
    await sleep(500)
    tty.type(o.typed)
    assert.ok(await until(() => tty.lines().at(-1) === o.typed), `the typed line is echoed, wrapped over two rows\n${dump()}`)
    for (const i of [1, 2, 3]) {
      done = await o.change(env, i)
      assert.ok(await until(() => o.shown(i)(frame()) && frame().at(-1) === o.typed), `redraw ${i}: the change is on the screen and the half-typed line is back under it\n${dump()}`)
    }
    const f = frame()
    assert.equal(f.at(-1), o.typed, `the half-typed line is the last line, whole\n${dump()}`)
    assert.ok(o.last(f.slice(0, -1)), `and the frame above it is whole: no row of it was erased by the typed line\n${dump()}`)
    await done?.()
    done = undefined
    tty.type('\x03')
    assert.equal(await within(tty.exited, 15_000), 0, `Ctrl-C on the terminal is a clean stop\n${dump()}`)
    server.p.kill('SIGINT')
    assert.equal(await within(server.exited, 15_000), 0, 'the server stopped cleanly on Ctrl-C')
  } finally {
    await done?.().catch(() => {})
    if (tty.p.exitCode === null) tty.p.kill('SIGTERM')
    if (server.p.exitCode === null) server.p.kill('SIGKILL')
  }
}

// a line longer than the 40-column terminal: it wraps onto a second row
const LONG = 'the half-typed line is long enough to wrap onto row two'

test('examples/40-chat: a half-typed line that wraps comes back whole under every redraw, and the frame above it stays whole', { skip: !hasPty && 'needs python3 with the pty module', timeout: 90_000 }, async () => {
  const room = path.join(ROOT, '40-chat', 'room-tty')
  rmSync(room, { recursive: true, force: true })
  let me: Awaited<ReturnType<typeof fero>> | undefined
  const saved = process.env.FERO_RENDEZVOUS
  try {
    await story({
      dir: '40-chat', server: ['room.ts', 'tty'], ready: 'ROOM tty', typist: ['join.ts', 'tty', 'ada'], head: 'CHAT tty', typed: LONG,
      change: async (env, i) => {
        if (!me) { process.env.FERO_RENDEZVOUS = env.FERO_RENDEZVOUS; me = await fero('chat-tty') }
        await me.methods.post({ nick: 'bob', text: `line ${i}` })
        return async () => { await me?.destroy(); me = undefined }
      },
      shown: (i) => (f) => f.some((l) => l.endsWith(`<bob> line ${i}`)),
      last: (f) => f.length === 4 && [1, 2, 3].every((i) => / <bob> line \d$/.test(f[i]) && f[i].endsWith(`line ${i}`)),
    })
  } finally {
    await me?.destroy().catch(() => {})
    if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved
    rmSync(room, { recursive: true, force: true })
  }
})

test('examples/41-kanban: a half-typed command that wraps comes back whole under every redraw, and the board above it stays whole', { skip: !hasPty && 'needs python3 with the pty module', timeout: 90_000 }, async () => {
  let c: Awaited<ReturnType<typeof fero>> | undefined
  const saved = process.env.FERO_RENDEZVOUS
  try {
    await story({
      dir: '41-kanban', server: ['board.ts'], ready: 'BOARD ', typist: ['edit.ts', 'ada'], head: 'EDIT ada', typed: `add c9 ${LONG}`,
      change: async (env, i) => {
        if (!c) { process.env.FERO_RENDEZVOUS = env.FERO_RENDEZVOUS; c = await fero('board') }
        c.data[`b${i}`].patch([['status', 'todo'], ['title', `card ${i}`]])
        return async () => { await c?.destroy(); c = undefined }
      },
      shown: (i) => (f) => f.join('\n').includes(`'card ${i}'`),
      // the frame is the header, then the columns object, which ends with its closing brace
      last: (f) => f[0].startsWith('EDIT ada') && f.at(-1)!.endsWith('}') && [1, 2, 3].every((i) => f.join('\n').includes(`'card ${i}'`)),
    })
  } finally {
    await c?.destroy().catch(() => {})
    if (saved === undefined) delete process.env.FERO_RENDEZVOUS; else process.env.FERO_RENDEZVOUS = saved
  }
})
